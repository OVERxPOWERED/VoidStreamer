const EventEmitter = require('events');

class MetricsAggregatorService extends EventEmitter {
  constructor(options = {}) {
    super();
    this.circuitBreakers = options.circuitBreakers || new Map();
    this.queryCache = options.queryCache || null;
    this.healthMonitor = options.healthMonitor || null;
    this.scheduler = options.scheduler || null;
    this.collectionInterval = null;
    this.isCollecting = false;
  }

  getMetricsSnapshot() {
    const snapshot = {
      timestamp: new Date().toISOString(),
      circuitBreakerStates: this._collectCircuitBreakerMetrics(),
      cacheStats: this._collectCacheMetrics(),
      healthCheckMetrics: this._collectHealthMonitorMetrics(),
      schedulerStats: this._collectSchedulerMetrics()
    };

    this.emit('metricsCollected', snapshot);
    return snapshot;
  }

  _collectCircuitBreakerMetrics() {
    const states = {};
    for (const [name, breaker] of this.circuitBreakers.entries()) {
      if (breaker && typeof breaker.getState === 'function') {
        states[name] = breaker.getState();
      } else if (breaker && typeof breaker.state !== 'undefined') {
        states[name] = {
          state: breaker.state,
          failures: breaker.failures || 0,
          successes: breaker.successes || 0,
          lastFailure: breaker.lastFailure || null,
          lastSuccess: breaker.lastSuccess || null
        };
      }
    }
    return states;
  }

  _collectCacheMetrics() {
    if (!this.queryCache) {
      return { available: false };
    }

    if (typeof this.queryCache.getStats === 'function') {
      return {
        available: true,
        ...this.queryCache.getStats()
      };
    }

    return {
      available: true,
      size: this.queryCache.size || 0,
      hits: this.queryCache.hits || 0,
      misses: this.queryCache.misses || 0,
      hitRate: this.queryCache.hitRate || 0
    };
  }

  _collectHealthMonitorMetrics() {
    if (!this.healthMonitor) {
      return { available: false };
    }

    if (typeof this.healthMonitor.getMetrics === 'function') {
      return {
        available: true,
        ...this.healthMonitor.getMetrics()
      };
    }

    if (typeof this.healthMonitor.getHealthStatus === 'function') {
      const status = this.healthMonitor.getHealthStatus();
      return {
        available: true,
        status: status.overall || 'unknown',
        checks: status.checks || {},
        lastCheck: status.lastCheck || null
      };
    }

    return {
      available: true,
      status: 'unknown',
      checks: {}
    };
  }

  _collectSchedulerMetrics() {
    if (!this.scheduler) {
      return { available: false };
    }

    if (typeof this.scheduler.getMetrics === 'function') {
      return {
        available: true,
        ...this.scheduler.getMetrics()
      };
    }

    if (typeof this.scheduler.getStats === 'function') {
      return {
        available: true,
        ...this.scheduler.getStats()
      };
    }

    return {
      available: true,
      running: this.scheduler.isRunning || false,
      jobs: this.scheduler.jobs?.size || 0,
      nextRun: this.scheduler.nextRun || null
    };
  }

  startCollection(intervalMs = 30000) {
    if (this.isCollecting) {
      return false;
    }

    this.isCollecting = true;
    this.collectionInterval = setInterval(() => {
      this.getMetricsSnapshot();
    }, intervalMs);

    this.collectionInterval.unref();
    return true;
  }

  stopCollection() {
    if (!this.isCollecting || !this.collectionInterval) {
      return false;
    }

    clearInterval(this.collectionInterval);
    this.collectionInterval = null;
    this.isCollecting = false;
    return true;
  }

  setCircuitBreakers(circuitBreakers) {
    this.circuitBreakers = circuitBreakers || new Map();
  }

  setQueryCache(queryCache) {
    this.queryCache = queryCache;
  }

  setHealthMonitor(healthMonitor) {
    this.healthMonitor = healthMonitor;
  }

  setScheduler(scheduler) {
    this.scheduler = scheduler;
  }
}

const defaultMetricsAggregator = new MetricsAggregatorService();

module.exports = {
  MetricsAggregatorService,
  defaultMetricsAggregator
};