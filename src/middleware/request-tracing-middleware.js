const { AsyncLocalStorage } = require('async_hooks');
const structuredLoggingService = require('../services/structured-logging-service');

const correlationIdStore = new AsyncLocalStorage();

const SENSITIVE_HEADER_KEYS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'proxy-authorization',
  'www-authenticate',
]);

const SENSITIVE_BODY_FIELDS = new Set([
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'access_token',
  'refresh_token',
  'api_key',
  'apikey',
  'client_secret',
  'clientSecret',
  'private_key',
  'privateKey',
  'ssn',
  'social_security_number',
  'credit_card',
  'creditCard',
  'cvv',
  'cvc',
  'pin',
  'otp',
  'one_time_password',
  'auth_code',
  'authorization_code',
]);

function sanitizeHeaders(headers) {
  if (!headers || typeof headers !== 'object') {
    return {};
  }

  const sanitized = {};
  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_HEADER_KEYS.has(lowerKey)) {
      sanitized[key] = '[REDACTED]';
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

function sanitizeBody(body) {
  if (!body || typeof body !== 'object') {
    return body;
  }

  const sanitized = Array.isArray(body) ? [] : {};

  for (const [key, value] of Object.entries(body)) {
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_BODY_FIELDS.has(lowerKey)) {
      sanitized[key] = '[REDACTED]';
    } else if (value && typeof value === 'object') {
      sanitized[key] = sanitizeBody(value);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

function generateCorrelationId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 15)}`;
}

function getClientIp(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    req.ip ||
    'unknown'
  );
}

function requestTracingMiddleware(req, res, next) {
  const startTime = process.hrtime.bigint();
  const correlationId = req.headers['x-correlation-id'] || generateCorrelationId();

  req.correlationId = correlationId;
  res.setHeader('x-correlation-id', correlationId);

  const requestContext = {
    correlationId,
    requestId: correlationId,
    startTime: Date.now(),
    method: req.method,
    path: req.path,
    query: req.query,
    ip: getClientIp(req),
    userAgent: req.headers['user-agent'] || 'unknown',
  };

  correlationIdStore.run(requestContext, () => {
    const sanitizedHeaders = sanitizeHeaders(req.headers);
    const sanitizedBody = sanitizeBody(req.body);

    structuredLoggingService.info('HTTP request started', {
      correlationId,
      method: req.method,
      path: req.path,
      query: req.query,
      ip: requestContext.ip,
      userAgent: requestContext.userAgent,
      headers: sanitizedHeaders,
      body: sanitizedBody,
    });

    const originalSend = res.send;
    res.send = function (body) {
      const durationNs = Number(process.hrtime.bigint() - startTime);
      const durationMs = durationNs / 1_000_000;

      const responseSize = Buffer.byteLength(body || '', 'utf8');

      structuredLoggingService.info('HTTP request completed', {
        correlationId,
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
        responseSize,
        ip: requestContext.ip,
      });

      return originalSend.call(this, body);
    };

    const originalJson = res.json;
    res.json = function (body) {
      const durationNs = Number(process.hrtime.bigint() - startTime);
      const durationMs = durationNs / 1_000_000;

      const responseBody = JSON.stringify(body);
      const responseSize = Buffer.byteLength(responseBody, 'utf8');

      structuredLoggingService.info('HTTP request completed', {
        correlationId,
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
        responseSize,
        ip: requestContext.ip,
      });

      return originalJson.call(this, body);
    };

    const originalEnd = res.end;
    res.end = function (chunk, encoding) {
      if (!res.headersSent) {
        const durationNs = Number(process.hrtime.bigint() - startTime);
        const durationMs = durationNs / 1_000_000;

        const responseSize = chunk ? Buffer.byteLength(chunk, encoding || 'utf8') : 0;

        structuredLoggingService.info('HTTP request completed', {
          correlationId,
          method: req.method,
          path: req.path,
          statusCode: res.statusCode,
          durationMs: Math.round(durationMs * 100) / 100,
          responseSize,
          ip: requestContext.ip,
        });
      }
      return originalEnd.call(this, chunk, encoding);
    };

    next();
  });
}

function errorTracingMiddleware(err, req, res, next) {
  const correlationId = req.correlationId || req.headers['x-correlation-id'] || 'unknown';
  const durationMs = req.startTime ? Date.now() - req.startTime : 0;

  structuredLoggingService.error('Unhandled error in request', {
    correlationId,
    method: req.method,
    path: req.path,
    statusCode: err.statusCode || err.status || 500,
    durationMs,
    ip: getClientIp(req),
    error: {
      name: err.name,
      message: err.message,
      stack: err.stack,
      code: err.code,
    },
  });

  if (!res.headersSent) {
    res.setHeader('x-correlation-id', correlationId);
    const statusCode = err.statusCode || err.status || 500;
    res.status(statusCode).json({
      error: {
        message: statusCode === 500 ? 'Internal server error' : err.message,
        correlationId,
      },
    });
  }

  next(err);
}

function getCorrelationId() {
  const store = correlationIdStore.getStore();
  return store?.correlationId || null;
}

function getRequestContext() {
  return correlationIdStore.getStore();
}

module.exports = {
  requestTracingMiddleware,
  errorTracingMiddleware,
  getCorrelationId,
  getRequestContext,
  correlationIdStore,
  sanitizeHeaders,
  sanitizeBody,
};