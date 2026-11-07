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
    return streamState;
  }

  removeStream(url) {
    this.monitoredStreams.delete(url);
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

      await this._cacheHealthResult(url, streamState);
      this._emitHealthChange(url, previousStatus, streamState.status, streamState);

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

      await this._cacheHealthResult(url, streamState);
      this._emitHealthChange(url, previousStatus, streamState.status, streamState);

      return { ...streamState, healthy: false, error: error.message };

    } finally {
      this.semaphore.release();
    }
  }

  async _performHealthCheck(url, options) {
    try {
      const response = await this.streamScraper.fetchStreamManifest(url, {
        timeout: options.timeoutMs,
        headers: { 'Accept': '*/*' }
      });

      if (!response || response.status >= 400) {
        return { healthy: false, details: `HTTP ${response?.status || 'No response'}` };
      }

      const contentType = response.headers?.['content-type'] || '';
      if (options.expectedContentType && !contentType.includes(options.expectedContentType)) {
        return { healthy: false, details: `Unexpected content type: ${contentType}` };
      }

      if (options.validateContent) {
        const contentValid = await this._validateStreamContent(response.data, contentType);
        if (!contentValid) {
          return { healthy: false, details: 'Stream content validation failed' };
        }
      }

      return { healthy: true, details: 'OK', contentType };

    } catch (error) {
      return { healthy: false, details: error.message };
    }
  }

  async _validateStreamContent(data, contentType) {
    if (!data) return false;
    
    if (contentType.includes('application/vnd.apple.mpegurl') || contentType.includes('application/x-mpegURL')) {
      const manifest = data.toString();
      return manifest.includes('#EXTM3U') && (manifest.includes('#EXT-X-STREAM-INF') || manifest.includes('#EXTINF:'));
    }
    
    if (contentType.includes('application/dash+xml')) {
      const manifest = data.toString();
      return manifest.includes('<MPD') && manifest.includes('xmlns="urn:mpeg:dash:schema:mpd:2011"');
    }

    return true;
  }

  async _cacheHealthResult(url, streamState) {
    const cacheKey = `health:${url}`;
    const cacheData = {
      url: streamState.url,
      status: streamState.status,
      latencyMs: streamState.latencyMs,
      lastCheck: streamState.lastCheck,
      errorCount: streamState.errorCount,
      consecutiveFailures: streamState.consecutiveFailures
    };
    
    await this.queryCache.set(cacheKey, cacheData, { ttl: this.config.cacheTTL });
  }

  _emitHealthChange(url, previousStatus, newStatus, streamState) {
    if (previousStatus !== newStatus) {
      this.emit('health-change', {
        url,
        previousStatus,
        newStatus,
        timestamp: new Date().toISOString(),
        latencyMs: streamState.latencyMs,
        consecutiveFailures: streamState.consecutiveFailures
      });
    }
  }

  async startMonitoring() {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    
    const runChecks = async () => {
      if (!this.isRunning) return;
      
      const urls = Array.from(this.monitoredStreams.keys());
      const checkPromises = urls.map(url => this.checkStreamHealth(url).catch(err => ({
        url,
        healthy: false,
        error: err.message
      })));

      await Promise.allSettled(checkPromises);
    };

    await runChecks();
    
    this.checkInterval = setInterval(runChecks, this.config.checkIntervalMs);
    this.checkInterval.unref();
  }

  stopMonitoring() {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  getHealthStatus(url) {
    const streamState = this.monitoredStreams.get(url);
    if (!streamState) {
      return null;
    }

    const circuitBreaker = this.circuitBreakers.get(url);
    return {
      ...streamState,
      circuitBreakerState: circuitBreaker ? circuitBreaker.getState() : null,
      uptimePercentage: streamState.totalChecks > 0 
        ? ((streamState.successfulChecks / streamState.totalChecks) * 100).toFixed(2)
        : 0
    };
  }

  getHealthReport() {
    const streams = Array.from(this.monitoredStreams.values());
    const totalMonitored = streams.length;
    
    if (totalMonitored === 0) {
      return {
        totalMonitored: 0,
        healthy: 0,
        degraded: 0,
        unhealthy: 0,
        avgLatencyMs: 0,
        uptimePercentage: 0
      };
    }

    const healthy = streams.filter(s => s.status === 'healthy').length;
    const degraded = streams.filter(s => s.status === 'degraded').length;
    const unhealthy = streams.filter(s => s.status === 'unhealthy').length;
    
    const latencies = streams
      .filter(s => s.latencyMs !== null)
      .map(s => s.latencyMs);
    const avgLatencyMs = latencies.length > 0
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : 0;

    const totalChecks = streams.reduce((sum, s) => sum + s.totalChecks, 0);
    const totalSuccessful = streams.reduce((sum, s) => sum + s.successfulChecks, 0);
    const uptimePercentage = totalChecks > 0 
      ? parseFloat(((totalSuccessful / totalChecks) * 100).toFixed(2))
      : 0;

    return {
      totalMonitored,
      healthy,
      degraded,
      unhealthy,
      avgLatencyMs,
      uptimePercentage,
      timestamp: new Date().toISOString()
    };
  }

  async getCachedHealth(url) {
    const cacheKey = `health:${url}`;
    return await this.queryCache.get(cacheKey);
  }

  destroy() {
    this.stopMonitoring();
    
    for (const [url, breaker] of this.circuitBreakers) {
      breaker.destroy();
    }
    this.circuitBreakers.clear();
    this.monitoredStreams.clear();
    this.removeAllListeners();
  }
}

const defaultInstance = new StreamHealthMonitorService();

module.exports = StreamHealthMonitorService;
module.exports.default = defaultInstance;