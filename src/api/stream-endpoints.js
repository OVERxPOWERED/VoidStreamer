```javascript
import express from 'express';
import { InputSanitizationService } from '../services/input-sanitization-service.js';
import { StreamDomainService } from '../services/stream-domain-service.js';
import { TelemetryService } from '../services/telemetry-service.js';

const router = express.Router();
const inputSanitization = new InputSanitizationService();
const streamDomain = new StreamDomainService();
const telemetry = new TelemetryService();

function generateCorrelationId() {
  return `req_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

function createResponse(success, data, error, meta = {}) {
  return { success, data, error, meta };
}

router.use((req, res, next) => {
  req.correlationId = req.headers['x-correlation-id'] || generateCorrelationId();
  res.setHeader('x-correlation-id', req.correlationId);
  next();
});

router.get('/api/streams/search', async (req, res) => {
  const startTime = Date.now();
  const correlationId = req.correlationId;

  try {
    const { q, page, limit } = req.query;

    const sanitizedQuery = inputSanitization.sanitizeSearchQuery(q);
    const sanitizedPage = inputSanitization.sanitizePage(page);
    const sanitizedLimit = inputSanitization.sanitizeLimit(limit);

    const validationErrors = inputSanitization.getValidationErrors();
    if (validationErrors.length > 0) {
      telemetry.recordRequest(correlationId, '/api/streams/search', 'GET', 400, Date.now() - startTime);
      return res.status(400).json(createResponse(false, null, {
        code: 'VALIDATION_ERROR',
        message: 'Invalid query parameters',
        details: validationErrors
      }, { correlationId }));
    }

    const result = await streamDomain.searchStreams(sanitizedQuery, sanitizedPage, sanitizedLimit);

    telemetry.recordRequest(correlationId, '/api/streams/search', 'GET', 200, Date.now() - startTime);
    telemetry.recordSearch(sanitizedQuery, result.total, Date.now() - startTime);

    res.json(createResponse(true, result.streams, null, {
      correlationId,
      pagination: {
        page: sanitizedPage,
        limit: sanitizedLimit,
        total: result.total,
        totalPages: Math.ceil(result.total / sanitizedLimit)
      }
    }));
  } catch (error) {
    telemetry.recordRequest(correlationId, '/api/streams/search', 'GET', 500, Date.now() - startTime);
    telemetry.recordError(correlationId, error);

    res.status(500).json(createResponse(false, null, {
      code: 'INTERNAL_ERROR',
      message: 'Failed to search streams',
      details: error.message
    }, { correlationId }));
  }
});

router.get('/api/streams/:sourceId/:streamId/resolve', async (req, res) => {
  const startTime = Date.now();
  const correlationId = req.correlationId;

  try {
    const { sourceId, streamId } = req.params;
    const { quality } = req.query;

    const sanitizedSourceId = inputSanitization.sanitizeSourceId(sourceId);
    const sanitizedStreamId = inputSanitization.sanitizeStreamId(streamId);
    const sanitizedQuality = inputSanitization.sanitizeQuality(quality);

    const validationErrors = inputSanitization.getValidationErrors();
    if (validationErrors.length > 0) {
      telemetry.recordRequest(correlationId, '/api/streams/:sourceId/:streamId/resolve', 'GET', 400, Date.now() - startTime);
      return res.status(400).json(createResponse(false, null, {
        code: 'VALIDATION_ERROR',
        message: 'Invalid parameters',
        details: validationErrors
      }, { correlationId }));
    }

    const streamUrl = await streamDomain.resolveStream(sanitizedSourceId, sanitizedStreamId, sanitizedQuality);

    if (!streamUrl) {
      telemetry.recordRequest(correlationId, '/api/streams/:sourceId/:streamId/resolve', 'GET', 404, Date.now() - startTime);
      return res.status(404).json(createResponse(false, null, {
        code: 'NOT_FOUND',
        message: 'Stream not found or unavailable'
      }, { correlationId }));
    }

    telemetry.recordRequest(correlationId, '/api/streams/:sourceId/:streamId/resolve', 'GET', 200, Date.now() - startTime);
    telemetry.recordResolution(sanitizedSourceId, sanitizedQuality, Date.now() - startTime);

    res.json(createResponse(true, { url: streamUrl, quality: sanitizedQuality }, null, { correlationId }));
  } catch (error) {
    telemetry.recordRequest(correlationId, '/api/streams/:sourceId/:streamId/resolve', 'GET', 500, Date.now() - startTime);
    telemetry.recordError(correlationId, error);

    res.status(500).json(createResponse(false, null, {
      code: 'INTERNAL_ERROR',
      message: 'Failed to resolve stream',
      details: error.message
    }, { correlationId }));
  }
});

router.get('/api/sources', async (req, res) => {
  const startTime = Date.now();
  const correlationId = req.correlationId;

  try {
    const sources = await streamDomain.getAvailableSources();

    telemetry.recordRequest(correlationId, '/api/sources', 'GET', 200, Date.now() - startTime);

    res.json(createResponse(true, sources, null, { correlationId }));
  } catch (error) {
    telemetry.recordRequest(correlationId, '/api/sources', 'GET', 500, Date.now() - startTime);
    telemetry.recordError(correlationId, error);

    res.status(500).json(createResponse(false, null, {
      code: 'INTERNAL_ERROR',
      message: 'Failed to retrieve sources',
      details: error.message
    }, { correlationId }));
  }
});

router.post('/api/sources', async (req, res) => {
  const startTime = Date.now();
  const correlationId = req.correlationId;

  try {
    const { name, baseUrl, config } = req.body;

    const sanitizedName = inputSanitization.sanitizeSourceName(name);
    const sanitizedBaseUrl = inputSanitization.sanitizeUrl(baseUrl);
    const sanitizedConfig = inputSanitization.sanitizeConfig(config);

    const validationErrors = inputSanitization.getValidationErrors();
    if (validationErrors.length > 0) {
      telemetry.recordRequest(correlationId, '/api/sources', 'POST', 400, Date.now() - startTime);
      return res.status(400).json(createResponse(false, null, {
        code: 'VALIDATION_ERROR',
        message: 'Invalid source configuration',
        details: validationErrors
      }, { correlationId }));
    }

    const source = await streamDomain.registerSource(sanitizedName, sanitizedBaseUrl, sanitizedConfig);

    telemetry.recordRequest