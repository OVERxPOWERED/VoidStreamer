```javascript
const { getConfig } = require('../config/environment-guardrails');
const { AppError, ErrorCodes } = require('./input-sanitization-service');

class TelemetryService {
  constructor() {
    this.serviceName = 'stream-domain-service';
    this.logLevel = this._getLogLevel();
    this.metrics = new Map();
    this.spans = new Map();
    this.healthCheckService = null;
  }

  setHealthCheckService(healthCheckService) {
    this.healthCheckService = healthCheckService;
  }

  _getLogLevel() {
    try {
      const config = getConfig();
      return config.LOG_LEVEL || 'info';
    } catch {
      return 'info';
    }
  }

  _shouldLog(level) {
    const levels = { debug: 0, info: 1, warn: 2, error: 3 };
    return levels[level] >= levels[this.logLevel];
  }

  _createLogEntry(level, message, traceId, meta = {}) {
    return JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      service: this.serviceName,
      traceId,
      message,
      ...meta
    });
  }

  generateTraceId() {
    return `trace-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
  }

  generateSpanId() {
    return `span-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
  }

  info(message, traceId, meta = {}) {
    if (this._shouldLog('info')) {
      console.log(this._createLogEntry('info', message, traceId, meta));
    }
  }

  warn(message, traceId, meta = {}) {
    if (this._shouldLog('warn')) {
      console.warn(this._createLogEntry('warn', message, traceId, meta));
    }
  }

  error(message, traceId, meta = {}) {
    if (this._shouldLog('error')) {
      console.error(this._createLogEntry('error', message, traceId, meta));
    }
  }

  debug(message, traceId, meta = {}) {
    if (this._shouldLog('debug')) {
      console.debug(this._createLogEntry('debug', message, traceId, meta));
    }
  }

  recordMetric(name, value, tags = {}) {
    const key = `${name}:${JSON.stringify(tags)}`;
    const existing = this.metrics.get(key) || { count: 0, sum: 0, min: Infinity, max: -Infinity };
    
    existing.count += 1;
    existing.sum += value;
    existing.min = Math.min(existing.min, value);
    existing.max = Math.max(existing.max, value);
    existing.avg = existing.sum / existing.count;
    existing.lastValue = value;
    existing.lastUpdated = new Date().toISOString();
    existing.tags = tags;
    
    this.metrics.set(key, existing);
    
    this.debug(`Metric recorded: ${name}`, tags.traceId, { name, value, tags, stats: existing });
    
    if (this.healthCheckService && name.startsWith('health.')) {
      this.healthCheckService.recordMetric(name, value, tags);
    }
  }

  recordCounter(name, tags = {}, increment = 1) {
    const key = `counter:${name}:${JSON.stringify(tags)}`;
    const existing = this.metrics.get(key) || { count: 0, tags };
    existing.count += increment;
    existing.lastUpdated = new Date().toISOString();
    this.metrics.set(key, existing);
    return existing.count;
  }

  recordGauge(name, value, tags = {}) {
    const key = `gauge:${name}:${JSON.stringify(tags)}`;
    const existing = this.metrics.get(key) || { tags };
    existing.value = value;
    existing.lastUpdated = new Date().toISOString();
    this.metrics.set(key, existing);
    return value;
  }

  recordHistogram(name, value, tags = {}) {
    const key = `histogram:${name}:${JSON.stringify(tags)}`;
    const existing = this.metrics.get(key) || { 
      count: 0, 
      sum: 0, 
      min: Infinity, 
      max: -Infinity,
      values: [],
      tags 
    };
    
    existing.count += 1;
    existing.sum += value;
    existing.min = Math.min(existing.min, value);
    existing.max = Math.max(existing.max, value);
    existing.avg = existing.sum / existing.count;
    existing.values.push(value);
    if (existing.values.length > 1000) {
      existing.values.shift();
    }
    existing.lastUpdated = new Date().toISOString();
    this.metrics.set(key, existing);
  }

  getMetrics() {
    const result = {};
    for (const [key, value] of this.metrics.entries()) {
      result[key] = { ...value };
    }
    return result;
  }

  getMetric(name, tags = {}) {
    const key = `${name}:${JSON.stringify(tags)}`;
    return this.metrics.get(key) || null;
  }

  resetMetrics() {
    this.metrics.clear();
  }

  classifyError(error) {
    if (!error) return 'unknown';
    
    const message = error.message || String(error);
    const code = error.code || error.statusCode || error.status;
    
    if (code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || 
        code === 'ENETUNREACH' || code === 'EAI_AGAIN' || message.includes('network') ||
        message.includes('timeout') || message.includes('connection')) {
      return 'network';
    }
    
    if (code === 400 || code === 422 || message.includes('validation') || 
        message.includes('invalid') || message.includes('required') ||
        error.name === 'ValidationError') {
      return 'validation';
    }
    
    if (message.includes('parse') || message.includes('JSON') || 
        message.includes('syntax') || error.name === 'SyntaxError' ||
        error.name === 'ParseError') {
      return 'parsing';
    }
    
    if (code >= 500 || code === 429 || message.includes('upstream') ||
        message.includes('service unavailable') || message.includes('gateway')) {
      return 'upstream';
    }
    
    if (code === 401 || code === 403 || message.includes('unauthorized') ||
        message.includes('forbidden') || message.includes('auth')) {
      return 'authentication';
    }
    
    if (code === 404 || message.includes('not found')) {
      return 'not_found';
    }
    
    return 'unknown';
  }

  recordError(error, context = {}) {
    const traceId = context.traceId || this.generateTraceId();
    const classification = this.classifyError(error);
    
    const errorRecord = {
      timestamp: new Date().toISOString(),
      traceId,
      classification,
      error: {
        name: error?.name || 'Error',
        message: error?.message || String(error),
        code: error?.code || error?.statusCode || error?.status,
        stack: error?.stack
      },
      context: {
        ...context,
        service: this.serviceName