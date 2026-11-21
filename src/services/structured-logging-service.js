import { AsyncLocalStorage } from 'async_hooks';
import { telemetryService } from './telemetry-service.js';

const correlationIdStorage = new AsyncLocalStorage();

const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const DEFAULT_SERVICE_NAME = 'structured-logging-service';

function generateCorrelationId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 15)}`;
}

function getCurrentCorrelationId() {
  const store = correlationIdStorage.getStore();
  return store?.correlationId ?? null;
}

function setCorrelationId(correlationId) {
  const store = correlationIdStorage.getStore();
  if (store) {
    store.correlationId = correlationId;
  }
}

class StructuredLoggingService {
  constructor(options = {}) {
    this.serviceName = options.serviceName ?? DEFAULT_SERVICE_NAME;
    this.minLevel = options.minLevel ?? 'info';
    this.metadata = options.metadata ?? {};
    this.outputStream = options.outputStream ?? process.stdout;
    this.errorStream = options.errorStream ?? process.stderr;
  }

  _shouldLog(level) {
    return LOG_LEVELS[level] >= LOG_LEVELS[this.minLevel];
  }

  _getTimestamp() {
    return new Date().toISOString();
  }

  _buildLogEntry(level, message, metadata = {}) {
    const correlationId = getCurrentCorrelationId() ?? generateCorrelationId();
    return {
      timestamp: this._getTimestamp(),
      level,
      correlationId,
      service: this.serviceName,
      message,
      metadata: {
        ...this.metadata,
        ...metadata,
      },
    };
  }

  _write(level, logEntry) {
    const output = level === 'error' ? this.errorStream : this.outputStream;
    output.write(`${JSON.stringify(logEntry)}\n`);

    telemetryService.recordLogEvent({
      level,
      service: this.serviceName,
      correlationId: logEntry.correlationId,
      message: logEntry.message,
      metadata: logEntry.metadata,
    });
  }

  debug(message, metadata) {
    if (!this._shouldLog('debug')) return;
    const entry = this._buildLogEntry('debug', message, metadata);
    this._write('debug', entry);
  }

  info(message, metadata) {
    if (!this._shouldLog('info')) return;
    const entry = this._buildLogEntry('info', message, metadata);
    this._write('info', entry);
  }

  warn(message, metadata) {
    if (!this._shouldLog('warn')) return;
    const entry = this._buildLogEntry('warn', message, metadata);
    this._write('warn', entry);
  }

  error(message, metadata) {
    if (!this._shouldLog('error')) return;
    const entry = this._buildLogEntry('error', message, metadata);
    this._write('error', entry);
  }

  child(boundMetadata = {}) {
    return new StructuredLoggingService({
      serviceName: this.serviceName,
      minLevel: this.minLevel,
      metadata: { ...this.metadata, ...boundMetadata },
      outputStream: this.outputStream,
      errorStream: this.errorStream,
    });
  }

  withCorrelationId(correlationId, fn) {
    return correlationIdStorage.run({ correlationId }, fn);
  }

  runWithCorrelationId(fn) {
    const correlationId = generateCorrelationId();
    return correlationIdStorage.run({ correlationId }, fn);
  }

  setMinLevel(level) {
    if (LOG_LEVELS[level] !== undefined) {
      this.minLevel = level;
    }
  }

  getMinLevel() {
    return this.minLevel;
  }
}

const structuredLoggingService = new StructuredLoggingService();

function createLogger(options = {}) {
  return new StructuredLoggingService(options);
}

function getCorrelationId() {
  return getCurrentCorrelationId();
}

function runWithCorrelationId(correlationId, fn) {
  return correlationIdStorage.run({ correlationId }, fn);
}

export {
  StructuredLoggingService,
  structuredLoggingService,
  createLogger,
  getCorrelationId,
  runWithCorrelationId,
  correlationIdStorage,
  LOG_LEVELS,
};