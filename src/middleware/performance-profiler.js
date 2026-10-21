'use strict';

const telemetryService = require('../services/telemetry-service');

class PerformanceProfiler {
  constructor() {
    this.timers = new Map();
    this.metrics = new Map();
    this.requestProfiles = new Map();
  }

  startTimer(label) {
    const startTime = process.hrtime.bigint();
    this.timers.set(label, startTime);
    return startTime;
  }

  endTimer(label) {
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
    const profile = this.requestProfiles.get(requestId);
    if (!profile) return;
    if (profile.currentStage) {
      this.endStage(requestId);
    }
    profile.currentStage = stageName;
    profile.stageStartTime = process.hrtime.bigint();
  }

  endStage(requestId) {
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
    return result;
  }

  clear() {
    this.timers.clear();
    this.metrics.clear();
    this.requestProfiles.clear();
  }
}

const profiler = new PerformanceProfiler();

function profileMiddleware(req, res, next) {
  const requestId = req.headers['x-request-id'] || `req-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  req.requestId = requestId;
  profiler.startRequestProfile(requestId);
  profiler.startStage(requestId, 'total');

  const originalSend = res.send;
  res.send = function (body) {
    profiler.endStage(requestId);
    const profile = profiler.endRequestProfile(requestId);
    if (profile) {
      res.setHeader('X-Response-Time', `${profile.totalDurationMs.toFixed(2)}ms`);
      res.setHeader('X-Request-Id', requestId);
    }
    return originalSend.call(this, body);
  };

  next();
}

module.exports = {
  PerformanceProfiler,
  profiler,
  profileMiddleware
};