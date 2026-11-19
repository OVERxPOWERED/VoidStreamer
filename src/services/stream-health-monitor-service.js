'use strict';

const EventEmitter = require('events');
const CircuitBreaker = require('../utils/circuit-breaker');
const QueryCacheService = require('./query-cache-service');
const StreamScraperService = require('./stream-scraper-service');

class StreamHealthMonitorService extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      checkIntervalMs: config.checkIntervalMs || 60000,
      maxConcurrentChecks: config.maxConcurrentChecks || 10,
      circuitBreakerOptions: config.circuitBreakerOptions || {
        failureThreshold: 5,
        resetTimeoutMs: 30000,
        halfOpenRequests: 3
      },
      cacheTTL: config.cacheTTL || 300000
    };

    this.monitoredStreams = new Map();
    this.circuitBreakers = new Map();
    this.healthCheckMetrics = new Map();
    this.checkInterval = null;
    this.isRunning = false;
    this.queryCache = new QueryCacheService();
    this.streamScraper = new StreamScraperService();
    this.semaphore = this._createSemaphore(this.config.maxConcurrentChecks);
  }

  _createSemaphore(maxConcurrent) {
    let running = 0;
    const queue = [];

    return {
      acquire: () => new Promise(resolve => {
        if (running < maxConcurrent) {
          running++;
          resolve();
        } else {
          queue.push(resolve);
        }
      }),
      release: () => {
        running--;
        if (queue.length > 0) {
          running++;
          queue.shift()();
        }
      }
    };
  }

  addStream(url, options = {}) {
    if (this.monitoredStreams.has(url)) {
      return this.monitoredStreams.get(url);
    }

    const circuitBreaker = new CircuitBreaker(this.config.circuitBreakerOptions);
    this.circuitBreakers.set(url, circuitBreaker);

    const streamState = {
      url,
      lastCheck: null,
      status: 'unknown',
      latencyMs: null,
      errorCount: 0,
      consecutiveFailures: 0,
      totalChecks: 0,
      successfulChecks: 0,
      options: {
        expectedContentType: options.expectedContentType || 'video/',
        timeoutMs: options.timeoutMs || 10000,
        validateContent: options.validateContent !== false
      }
    };

    this.monitoredStreams.set(url, streamState);
    this._initializeHealthMetrics(url);
    return streamState;
  }

  _initializeHealthMetrics(url) {
    this.healthCheckMetrics.set(url, {
      totalChecks: 0,
      successfulChecks: 0,
      failedChecks: 0,
      lastCheckTime: null,
      avgLatencyMs: 0,
      totalLatencyMs: 0,
      retryStats: {
        totalRetries: 0,
        successfulRetries: 0,
        failedRetries: 0,
        avgRetryAttempts: 0,
        maxRetryAttempts: 0
      }
    });
  }

  removeStream(url) {
    this.monitoredStreams.delete(url);
    this.healthCheckMetrics.delete(url);
    const breaker = this.circuitBreakers.get(url);
    if (breaker) {
      breaker.destroy();
      this.circuitBreakers.delete(url);
    }
  }

  async checkStreamHealth(url) {
    const streamState = this.monitoredStreams.get(url);
    if (!streamState) {
      throw new Error(`Stream not monitored: ${url}`);
    }

    const circuitBreaker = this.circuitBreakers.get(url);
    const startTime = Date.now();

    try {
      await this.semaphore.acquire();
      
      const result = await circuitBreaker.execute(async () => {
        const healthResult = await this._performHealthCheck(url, streamState.options);
        return healthResult;
      });

      const latencyMs = Date.now() - startTime;
      const previousStatus = streamState.status;
      
      streamState.lastCheck = new Date().toISOString();
      streamState.latencyMs = latencyMs;
      streamState.totalChecks++;
      streamState.successfulChecks++;
      streamState.consecutiveFailures = 0;
      streamState.status = result.healthy ? 'healthy' : 'degraded';

      this._updateHealthMetrics(url, latencyMs, true, this.streamScraper.getRetryMetrics());
      await this._cacheHealthResult(url, streamState);
      this._emitHealthChange(url, previousStatus, streamState.status, streamState);
      this._emitHealthMetricsUpdated(url);

      return { ...streamState, healthy: result.healthy, details: result.details };

    } catch (error) {
      const latencyMs = Date.now() - startTime;
      const previousStatus = streamState.status;

      streamState.lastCheck = new Date().toISOString();
      streamState.latencyMs = latencyMs;
      streamState.totalChecks++;
      streamState.errorCount++;
      streamState.consecutiveFailures++;
      streamState.status = streamState.consecutiveFailures >= 3 ? 'unhealthy' : 'degraded';

      this._updateHealthMetrics(url, latencyMs, false, this.streamScraper.getRetryMetrics());
      await this._cacheHealthResult(url, streamState);
      this._emitHealthChange(url, previousStatus, streamState.status, streamState);
      this._emitHealthMetricsUpdated(url);

      throw error;
    } finally {
      this.semaphore.release();
    }
  }

  async _performHealthCheck(url, options) {
    const scrapeResult = await this.streamScraper.scrapeStream(url, {
      timeout: options.timeoutMs,
      validateContent: options.validateContent,
      expectedContentType: options.expectedContentType
    });

    return {
      healthy: scrapeResult.success,
      details: {
        statusCode: scrapeResult.statusCode,
        contentType: scrapeResult.contentType,
        contentLength: scrapeResult.contentLength,
        redirectUrl: scrapeResult.redirectUrl,
        error: scrapeResult.error
      }
    };
  }

  _updateHealthMetrics(url, latencyMs, success, retryMetrics) {
    const metrics = this.healthCheckMetrics.get(url);
    if (!metrics) return;

    metrics.totalChecks++;
    metrics.lastCheckTime = new Date().toISOString();
    metrics.totalLatencyMs += latencyMs;
    metrics.avgLatencyMs = Math.round(metrics.totalLatencyMs / metrics.totalChecks);

    if (success) {
      metrics.successfulChecks++;
    } else {
      metrics.failedChecks++;
    }

    if (retryMetrics) {
      metrics.retryStats.totalRetries += retryMetrics.totalRetries || 0;
      metrics.retryStats.successfulRetries += retryMetrics.successfulRetries || 0;
      metrics.retryStats.failedRetries += retryMetrics.failedRetries || 0;
      metrics.retryStats.avgRetryAttempts = retryMetrics.avgRetryAttempts || 0;
      metrics.retryStats.maxRetryAttempts = Math.max(
        metrics.retryStats.maxRetryAttempts,
        retryMetrics.maxRetryAttempts || 0
      );
    }
  }

  _emitHealthMetricsUpdated(url) {
    const metrics = this.getHealthMetrics(url);
    this.emit('healthMetricsUpdated', {
      streamUrl: url,
      timestamp: new Date().toISOString(),
      metrics
    });
  }

  getHealthMetrics(streamUrl) {
    if (streamUrl) {
      const metrics = this.healthCheckMetrics.get(streamUrl);
      const streamState = this.monitoredStreams.get(streamUrl);
      if (!metrics) return null;

      return {
        streamUrl,
        ...metrics,
        currentStatus: streamState?.status || 'unknown',
        lastCheck: streamState?.lastCheck || null,
        circuitBreakerState: this.circuitBreakers.get(streamUrl)?.getState() || 'unknown'
      };
    }

    return this.getAllHealthMetrics();
  }

  getAllHealthMetrics() {
    const allMetrics = {};
    for (const [url, metrics] of this.healthCheckMetrics.entries()) {
      const streamState = this.monitoredStreams.get(url);
      allMetrics[url] = {
        streamUrl: url,
        ...metrics,
        currentStatus: streamState?.status || 'unknown',
        lastCheck: streamState?.lastCheck || null,
        circuitBreakerState: this.circuitBreakers.get(url)?.getState() || 'unknown'
      };
    }
    return allMetrics;
  }

  async _cacheHealthResult(url, streamState) {
    const cacheKey = `health:${url}`;
    await this.queryCache.set(cacheKey, streamState, this.config.cacheTTL);
  }

  _emitHealthChange(url, previousStatus, newStatus, streamState) {
    if (previousStatus !== newStatus) {
      this.emit('healthChange', {
        url,
        previousStatus,
        newStatus,
        timestamp: new Date().toISOString(),
        streamState
      });
    }
    this.emit('checkComplete', {
      url,
      status: newStatus,
      timestamp: new Date().toISOString(),
      streamState
    });
  }

  async startMonitoring() {
    if (this.isRunning) return;
    
    this.isRunning = true;
    this.checkInterval = setInterval(async () => {
      await this._runHealthChecks();
    }, this.config.checkIntervalMs);

    await this._runHealthChecks();
    this.emit('monitoringStarted');
  }

  async stopMonitoring() {
    if (!this.isRunning) return;
    
    this.isRunning = false;
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    this.emit('monitoringStopped');
  }

  async _runHealthChecks() {
    const urls = Array.from(this.monitoredStreams.keys());
    const checkPromises = urls.map(url => 
      this.checkStreamHealth(url).catch(error => {
        this.emit('checkError', { url, error: error.message, timestamp: new Date().toISOString() });
      })
    );

    await Promise.allSettled(checkPromises);
  }

  getMonitoredStreams() {
    return Array.from(this.monitoredStreams.values());
  }

  getStreamState(url) {
    return this.monitoredStreams.get(url) || null;
  }

  async shutdown() {
    await this.stopMonitoring();
    for (const [url, breaker] of this.circuitBreakers.entries()) {
      breaker.destroy();
    }
    this.circuitBreakers.clear();
    this.monitoredStreams.clear();
    this.healthCheckMetrics.clear();
    await this.queryCache.clear();
    this.removeAllListeners();
  }
}

module.exports = StreamHealthMonitorService;