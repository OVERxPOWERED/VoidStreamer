'use strict';

const telemetryService = require('../services/telemetry-service');
const ProfileHotPathsService = require('../services/profile-hot-paths-service');

class PerformanceProfiler {
  constructor(options = {}) {
    this.timers = new Map();
    this.metrics = new Map();
    this.requestProfiles = new Map();
    this.hotPathsService = options.hotPathsService || new ProfileHotPathsService();
    this.enabled = options.enabled !== false;
    this.sampleRate = options.sampleRate || 1.0;
    
    this._setupAxiosInterceptors();
  }

  _setupAxiosInterceptors() {
    if (typeof axios === 'undefined') {
      try {
        const axios = require('axios');
        this._axios = axios;
      } catch (e) {
        this._axios = null;
      }
    } else {
      this._axios = axios;
    }

    if (this._axios) {
      this._axios.interceptors.request.use((config) => {
        config.metadata = config.metadata || {};
        config.metadata._profilerStartTime = process.hrtime.bigint();
        config.metadata._profilerUrl = config.url;
        config.metadata._profilerMethod = config.method?.toUpperCase();
        return config;
      });

      this._axios.interceptors.response.use(
        (response) => {
          this._recordUpstreamCall(response.config, null, response.status);
          return response;
        },
        (error) => {
          this._recordUpstreamCall(error.config, error, error.response?.status);
          return Promise.reject(error);
        }
      );
    }
  }

  _recordUpstreamCall(config, error, statusCode) {
    if (!config?.metadata?._profilerStartTime) return;
    
    const durationNs = Number(process.hrtime.bigint() - config.metadata._profilerStartTime);
    const durationMs = durationNs / 1_000_000;
    
    const tags = {
      method: config.metadata._profilerMethod || 'UNKNOWN',
      url: this._sanitizeUrl(config.metadata._profilerUrl),
      status: statusCode || (error ? 'error' : 'unknown'),
      error: error ? error.code || error.message : 'none'
    };

    this.recordMetric('upstream_http_call_duration_ms', durationMs, tags);
    this.hotPathsService.recordCall('upstream_http', config.metadata._profilerUrl, durationMs, tags);
  }

  _sanitizeUrl(url) {
    if (!url) return 'unknown';
    try {
      const u = new URL(url, 'http://localhost');
      return `${u.pathname}${u.search}`;
    } catch {
      return url.replace(/^https?:\/\/[^/]+/, '');
    }
  }

  startTimer(label) {
    if (!this.enabled) return null;
    const startTime = process.hrtime.bigint();
    this.timers.set(label, startTime);
    return startTime;
  }

  endTimer(label) {
    if (!this.enabled) return null;
    const startTime = this.timers.get(label);
    if (!startTime) {
      return null;
    }
    const endTime = process.hrtime.bigint();
    const durationNs = Number(endTime - startTime);
    const durationMs = durationNs / 1_000_000;
    this.timers.delete(label);
    return durationMs;
  }

  recordMetric(name, value, tags = {}) {
    if (!this.enabled) return;
    if (Math.random() > this.sampleRate) return;

    const key = this._getMetricKey(name, tags);
    if (!this.metrics.has(key)) {
      this.metrics.set(key, {
        name,
        tags,
        values: [],
        count: 0,
        sum: 0,
        min: Infinity,
        max: -Infinity
      });
    }
    const metric = this.metrics.get(key);
    metric.values.push(value);
    metric.count++;
    metric.sum += value;
    metric.min = Math.min(metric.min, value);
    metric.max = Math.max(metric.max, value);

    if (metric.values.length > 10000) {
      metric.values.shift();
    }

    telemetryService.recordMetric(name, value, tags);
    this.hotPathsService.recordMetric(name, value, tags);
  }

  _getMetricKey(name, tags) {
    const tagStr = Object.entries(tags)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(',');
    return `${name}{${tagStr}}`;
  }

  getSummary() {
    const summary = {};
    for (const [key, metric] of this.metrics.entries()) {
      const sortedValues = [...metric.values].sort((a, b) => a - b);
      const p50 = this._percentile(sortedValues, 50);
      const p95 = this._percentile(sortedValues, 95);
      const p99 = this._percentile(sortedValues, 99);
      summary[key] = {
        name: metric.name,
        tags: metric.tags,
        count: metric.count,
        sum: metric.sum,
        min: metric.min,
        max: metric.max,
        mean: metric.sum / metric.count,
        p50,
        p95,
        p99
      };
    }
    return summary;
  }

  _percentile(sortedValues, percentile) {
    if (sortedValues.length === 0) return 0;
    const index = Math.ceil(percentile / 100 * sortedValues.length) - 1;
    return sortedValues[Math.max(0, index)];
  }

  startRequestProfile(requestId) {
    if (!this.enabled) return null;
    const profile = {
      requestId,
      startTime: process.hrtime.bigint(),
      stages: new Map(),
      currentStage: null,
      stageStartTime: null
    };
    this.requestProfiles.set(requestId, profile);
    return profile;
  }

  startStage(requestId, stageName) {
    if (!this.enabled) return;
    const profile = this.requestProfiles.get(requestId);
    if (!profile) return;
    if (profile.currentStage) {
      this.endStage(requestId);
    }
    profile.currentStage = stageName;
    profile.stageStartTime = process.hrtime.bigint();
  }

  endStage(requestId) {
    if (!this.enabled) return;
    const profile = this.requestProfiles.get(requestId);
    if (!profile || !profile.currentStage) return;
    const endTime = process.hrtime.bigint();
    const durationNs = Number(endTime - profile.stageStartTime);
    const durationMs = durationNs / 1_000_000;
    profile.stages.set(profile.currentStage, durationMs);
    profile.currentStage = null;
    profile.stageStartTime = null;
  }

  endRequestProfile(requestId) {
    if (!this.enabled) return null;
    const profile = this.requestProfiles.get(requestId);
    if (!profile) return null;
    if (profile.currentStage) {
      this.endStage(requestId);
    }
    const endTime = process.hrtime.bigint();
    const totalDurationNs = Number(endTime - profile.startTime);
    const totalDurationMs = totalDurationNs / 1_000_000;
    const result = {
      requestId: profile.requestId,
      totalDurationMs,
      stages: Object.fromEntries(profile.stages)
    };
    this.requestProfiles.delete(requestId);
    telemetryService.recordRequestProfile(result);
    this.hotPathsService.recordRequestProfile(result);
    return result;
  }

  clear() {
    this.timers.clear();
    this.metrics.clear();
    this.requestProfiles.clear();
  }

  expressMiddleware() {
    return (req, res, next) => {
      if (!this.enabled) return next();
      
      const requestId = req.headers['x-request-id'] || req.id || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      req.performanceProfile = this.startRequestProfile(requestId);
      req.profiler = this;

      const originalSend = res.send;
      res.send = function(body) {
        if (req.performanceProfile) {
          req.profiler.endRequestProfile(requestId);
        }
        return originalSend.call(this, body);
      };

      res.on('finish', () => {
        if (req.performanceProfile) {
          this.endRequestProfile(requestId);
        }
      });

      next();
    };
  }

  fastifyHook() {
    return async (request, reply) => {
      if (!this.enabled) return;
      
      const requestId = request.headers['x-request-id'] || request.id || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      request.performanceProfile = this.startRequestProfile(requestId);
      request.profiler = this;

      reply.raw.on('finish', () => {
        if (request.performanceProfile) {
          this.endRequestProfile(requestId);
        }
      });
    };
  }

  wrapCacheService(cacheService) {
    const originalGet = cacheService.get.bind(cacheService);
    const originalSet = cacheService.set.bind(cacheService);
    const originalDelete = cacheService.delete.bind(cacheService);

    cacheService.get = async (key, options) => {
      const timer = this.startTimer(`cache:get:${key}`);
      try {
        const result = await originalGet(key, options);
        const duration = this.endTimer(`cache:get:${key}`);
        this.recordMetric('cache_get_duration_ms', duration, { 
          hit: result !== null ? 'true' : 'false',
          key: this._sanitizeKey(key)
        });
        this.hotPathsService.recordCall('cache_get', key, duration, { hit: result !== null });
        return result;
      } catch (error) {
        this.endTimer(`cache:get:${key}`);
        this.recordMetric('cache_get_error', 1, { key: this._sanitizeKey(key), error: error.code || error.message });
        throw error;
      }
    };

    cacheService.set = async (key, value, options) => {
      const timer = this.startTimer(`cache:set:${key}`);
      try {
        const result = await originalSet(key, value, options);
        const duration = this.endTimer(`cache:set:${key}`);
        this.recordMetric('cache_set_duration_ms', duration, { key: this._sanitizeKey(key) });
        this.hotPathsService.recordCall('cache_set', key, duration, {});
        return result;
      } catch (error) {
        this.endTimer(`cache:set:${key}`);
        this.recordMetric('cache_set_error', 1, { key: this._sanitizeKey(key), error: error.code || error.message });
        throw error;
      }
    };

    cacheService.delete = async (key) => {
      const timer = this.startTimer(`cache:delete:${key}`);
      try {
        const result = await originalDelete(key);
        const duration = this.endTimer(`cache:delete:${key}`);
        this.recordMetric('cache_delete_duration_ms', duration, { key: this._sanitizeKey(key) });
        this.hotPathsService.recordCall('cache_delete', key, duration, {});
        return result;
      } catch (error) {
        this.endTimer(`cache:delete:${key}`);
        this.recordMetric('cache_delete_error', 1, { key: this._sanitizeKey(key), error: error.code || error.message });
        throw error;
      }
    };

    return cacheService;
  }

  wrapStreamDomainService(streamService) {
    const methods = ['createStream', 'getStream', 'updateStream', 'deleteStream', 'listStreams', 'publishEvent'];
    
    for (const method of methods) {
      if (typeof streamService[method] === 'function') {
        const original = streamService[method].bind(streamService);
        streamService[method] = async (...args) => {
          const timer = this.startTimer(`stream_domain:${method}`);
          try {
            const result = await original(...args);
            const duration = this.endTimer(`stream_domain:${method}`);
            this.recordMetric('stream_domain_service_duration_ms', duration, { method, service: 'stream-domain' });
            this.hotPathsService.recordCall('stream_domain_service', method, duration, {});
            return result;
          } catch (error) {
            this.endTimer(`stream_domain:${method}`);
            this.recordMetric('stream_domain_service_error', 1, { method, error: error.code || error.message });
            throw error;
          }
        };
      }
    }

    return streamService;
  }

  _sanitizeKey(key) {
    if (!key) return 'unknown';
    return key.length > 100 ? key.slice(0, 100) + '...' : key;
  }

  getHotPathsReport() {
    return this.hotPathsService.getReport();
  }

  resetHotPaths() {
    this.hotPathsService.reset();
  }
}

const profiler = new PerformanceProfiler({
  enabled: process.env.PERFORMANCE_PROFILER_ENABLED !== 'false',
  sampleRate: parseFloat(process.env.PERFORMANCE_PROFILER_SAMPLE_RATE) || 1.0
});

module.exports = {
  PerformanceProfiler,
  profiler
};