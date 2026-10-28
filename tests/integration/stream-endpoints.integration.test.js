const request = require('supertest');
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const { QueryCacheService } = require('../../src/services/query-cache.service');
const { StreamDomainService } = require('../../src/services/stream-domain.service');
const { telemetryService } = require('../../src/services/telemetry.service');
const streamEndpoints = require('../../src/api/stream-endpoints');
const { StreamDomainError, ErrorCodes } = require('../../src/domain/errors');
const { validateResponseSchema } = require('../../src/utils/schema-validator');

jest.mock('axios');
jest.mock('cheerio');
jest.mock('../../src/services/telemetry.service');

describe('Stream Endpoints Integration Tests', () => {
  let app;
  let server;
  let axiosMockAdapter;
  let queryCacheService;
  let streamDomainService;

  beforeAll(async () => {
    queryCacheService = new QueryCacheService({ ttl: 60000, maxSize: 100 });
    streamDomainService = new StreamDomainService({ queryCacheService });
    
    app = express();
    app.use(express.json());
    app.use('/api/streams', streamEndpoints);
    app.get('/health', (req, res) => {
      const { readiness } = req.query;
      if (readiness === 'true') {
        return res.status(200).json({ status: 'ready', checks: { database: 'ok', upstream: 'ok' } });
      }
      res.status(200).json({ status: 'alive' });
    });
    server = app.listen(0);
    await new Promise(resolve => server.on('listening', resolve));

    axiosMockAdapter = {
      get: jest.fn(),
      post: jest.fn()
    };
    axios.create.mockReturnValue(axiosMockAdapter);
  }, 30000);

  afterAll(async () => {
    await queryCacheService.shutdown();
    await new Promise(resolve => server.close(resolve));
    jest.clearAllMocks();
  }, 30000);

  beforeEach(() => {
    queryCacheService.clear();
    jest.clearAllMocks();
    telemetryService.recordError.mockReset();
    telemetryService.recordMetric.mockReset();
    cheerio.load.mockReset();
  });

  const baseUrl = '/api/streams';

  const mockSearchResponse = {
    results: [
      {
        id: 'tt0133093',
        title: 'The Matrix',
        year: 1999,
        type: 'movie',
        sources: [
          { name: 'Netflix', url: 'https://netflix.com/watch/tt0133093', quality: '4K' },
          { name: 'Amazon Prime', url: 'https://primevideo.com/watch/tt0133093', quality: 'HD' }
        ],
        poster: 'https://image.tmdb.org/t/p/w500/f89U3ADr1oiB1s9GkdPOEpXUk5H.jpg',
        imdbId: 'tt0133093'
      }
    ],
    pagination: { page: 1, limit: 10, total: 1, totalPages: 1 }
  };

  const mockEmptyResponse = {
    results: [],
    pagination: { page: 1, limit: 10, total: 0, totalPages: 0 }
  };

  const mockStreamDetailsResponse = {
    id: 'tt0133093',
    title: 'The Matrix',
    year: 1999,
    type: 'movie',
    sources: [
      { name: 'Netflix', url: 'https://netflix.com/watch/tt0133093', quality: '4K', language: 'en', subtitles: ['en', 'es'] },
      { name: 'Amazon Prime', url: 'https://primevideo.com/watch/tt0133093', quality: 'HD', language: 'en', subtitles: ['en'] }
    ],
    poster: 'https://image.tmdb.org/t/p/w500/f89U3ADr1oiB1s9GkdPOEpXUk5H.jpg',
    imdbId: 'tt0133093',
    runtime: 136,
    genres: ['Action', 'Sci-Fi'],
    overview: 'A computer hacker learns from mysterious rebels about the true nature of his reality.'
  };

  describe('GET /api/streams/search - Happy Path', () => {
    beforeEach(() => {
      axiosMockAdapter.get.mockResolvedValue({ data: mockSearchResponse });
    });

    it('should return 200 with valid search query', async () => {
      const response = await request(app)
        .get(`${baseUrl}/search`)
        .query({ q: 'matrix', page: 1, limit: 10 })
        .expect('Content-Type', /json/)
        .expect(200);

      expect(response.body).toHaveProperty('results');
      expect(response.body).toHaveProperty('pagination');
      expect(Array.isArray(response.body.results)).toBe(true);
      expect(response.body.results.length).toBeGreaterThan(0);
      expect(validateResponseSchema(response.body, 'search')).toBe(true);
    });

    it('should return cached response on subsequent identical requests', async () => {
      await request(app).get(`${baseUrl}/search`).query({ q: 'matrix', page: 1, limit: 10 }).expect(200);
      const response = await request(app).get(`${baseUrl}/search`).query({ q: 'matrix', page: 1, limit: 10 }).expect(200);
      
      expect(axiosMockAdapter.get).toHaveBeenCalledTimes(1);
      expect(response.headers['x-cache']).toBe('HIT');
    });

    it('should respect pagination parameters', async () => {
      const response = await request(app)
        .get(`${baseUrl}/search`)
        .query({ q: 'matrix', page: 2, limit: 5 })
        .expect(200);

      expect(response.body.pagination.page).toBe(2);
      expect(response.body.pagination.limit).toBe(5);
    });
  });

  describe('GET /api/streams/search - Empty Response Handling', () => {
    it('should return 200 with empty results for no matches', async () => {
      axiosMockAdapter.get.mockResolvedValue({ data: mockEmptyResponse });

      const response = await request(app)
        .get(`${baseUrl}/search`)
        .query({ q: 'nonexistentmovie12345', page: 1, limit: 10 })
        .expect(200);

      expect(response.body.results).toEqual([]);
      expect(response.body.pagination.total).toBe(0);
      expect(response.body.pagination.totalPages).toBe(0);
    });

    it('should return 204 when upstream returns 204 No Content', async () => {
      axiosMockAdapter.get.mockResolvedValue({ 
        data: null, 
        status: 204,
        statusText: 'No Content'
      });

      const response = await request(app)
        .get(`${baseUrl}/search`)
        .query({ q: 'empty' })
        .expect(204);

      expect(response.body).toEqual({});
    });

    it('should return 404 when upstream returns 404 Not Found', async () => {
      const error = new Error('Not Found');
      error.response = { status: 404, data: { message: 'Resource not found' } };
      axiosMockAdapter.get.mockRejectedValue(error);

      const response = await request(app)
        .get(`${baseUrl}/search`)
        .query({ q: 'notfound' })
        .expect(404);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error.code).toBe(ErrorCodes.UPSTREAM_NOT_FOUND);
    });

    it('should handle empty array in results field gracefully', async () => {
      axiosMockAdapter.get.mockResolvedValue({ 
        data: { results: [], pagination: { page: 1, limit: 10, total: 0, totalPages: 0 } } 
      });

      const response = await request(app)
        .get(`${baseUrl}/search`)
        .query({ q: 'empty' })
        .expect(200);

      expect(Array.isArray(response.body.results)).toBe(true);
      expect(response.body.results.length).toBe(0);
    });
  });

  describe('GET /api/streams/search - Malformed Data Handling', () => {
    it('should handle malformed JSON from upstream', async () => {
      const error = new Error('Unexpected token');
      error.response = { 
        status: 200, 
        data: 'invalid json response{',
        headers: { 'content-type': 'application/json' }
      };
      axiosMockAdapter.get.mockRejectedValue(error);

      const response = await request(app)
        .get(`${baseUrl}/search`)
        .query({ q: 'matrix' })
        .expect(502);

      expect(response.body.error.code).toBe(ErrorCodes.UPSTREAM_MALFORMED_RESPONSE);
      expect(telemetryService.recordError).toHaveBeenCalledWith(
        expect.objectContaining({ code: ErrorCodes.UPSTREAM_MALFORMED_RESPONSE })
      );
    });

    it('should handle HTML parsing errors with cheerio', async () => {
      const malformedHtml = '<html><body><div class="result">Unclosed div';
      cheerio.load.mockImplementation(() => {
        throw new Error('Cheerio parsing failed: malformed HTML');
      });
      axiosMockAdapter.get.mockResolvedValue({ 
        data: malformedHtml,
        headers: { 'content-type': 'text/html' }
      });

      const response = await request(app)
        .get(`${baseUrl}/search`)
        .query({ q: 'matrix' })
        .expect(502);

      expect(response.body.error.code).toBe(ErrorCodes.HTML_PARSING_ERROR);
      expect(cheerio.load).toHaveBeenCalledWith(malformedHtml);
    });

    it('should handle missing required fields in upstream response', async () => {
      const incompleteResponse = {
        results: [{ id: 'tt0133093' }],
        pagination: { page: 1, limit: 10, total: 1, totalPages: 1 }
      };
      axiosMockAdapter.get.mockResolvedValue({ data: incompleteResponse });

      const response = await request(app)
        .get(`${baseUrl}/search`)
        .query({ q: 'matrix' })
        .expect(502);

      expect(response.body.error.code).toBe(ErrorCodes.SCHEMA_VALIDATION_FAILED);
      expect(response.body.error.details).toContain('title');
    });

    it('should handle null/undefined values in critical fields', async () => {
      const responseWithNulls = {
        results: [
          { id: 'tt0133093', title: null, year: undefined, type: 'movie', sources: [], poster: null, imdbId: 'tt0133093' }
        ],
        pagination: { page: 1, limit: 10, total: 1, totalPages: 1 }
      };
      axiosMockAdapter.get.mockResolvedValue({ data: responseWithNulls });

      const response = await request(app)
        .get(`${baseUrl}/search`)
        .query({ q: 'matrix' })
        .expect(502);

      expect(response.body.error.code).toBe(ErrorCodes.SCHEMA_VALIDATION_FAILED);
    });

    it('should handle array where object expected', async () => {
      axiosMockAdapter.get.mockResolvedValue({ 
        data: { results: 'not-an-array', pagination: { page: 1, limit: 10, total: 0, totalPages: 0 } } 
      });

      const response = await request(app)
        .get(`${baseUrl}/search`)
        .query({ q: 'matrix' })
        .expect(502);

      expect(response.body.error.code).toBe(ErrorCodes.SCHEMA_VALIDATION_FAILED);
    });
  });

  describe('GET /api/streams/search - Timeout and Network Failures', () => {
    it('should handle request timeout (ETIMEDOUT)', async () => {
      const timeoutError = new Error('ETIMEDOUT');
      timeoutError.code = 'ETIMEDOUT';
      timeoutError.errno = 'ETIMEDOUT';
      axiosMockAdapter.get.mockRejectedValue(timeoutError);

      const response = await request(app)
        .get(`${baseUrl}/search`)
        .query({ q: 'matrix' })
        .expect(504);

      expect(response.body.error.code).toBe(ErrorCodes.UPSTREAM_TIMEOUT);
      expect(telemetryService.recordMetric).toHaveBeenCalledWith(
        'upstream.request.timeout',
        expect.any(Number),
        expect.objectContaining({ endpoint: 'search' })
      );
    });

    it('should handle connection refused (ECONNREFUSED)', async () => {
      const connError = new Error('ECONNREFUSED');
      connError.code = 'ECONNREFUSED';
      connError.errno = 'ECONNREFUSED';
      axiosMockAdapter.get.mockRejectedValue(connError);

      const response = await request(app)
        .get(`${baseUrl}/search`)
        .query({ q: 'matrix' })
        .expect(503);

      expect(response.body.error.code).toBe(ErrorCodes.UPSTREAM_UNAVAILABLE);
    });

    it('should handle DNS resolution failure (ENOTFOUND)', async () => {
      const dnsError = new Error('ENOTFOUND');
      dnsError.code = 'ENOTFOUND';
      dnsError.errno = 'ENOTFOUND';
      axiosMockAdapter.get.mockRejectedValue(dnsError);

      const response = await request(app)
        .get(`${baseUrl}/search`)
        .query({ q: 'matrix' })
        .expect(503);

      expect(response.body.error.code).toBe(ErrorCodes.UPSTREAM_UNAVAILABLE);
    });

    it('should handle socket hang up (ECONNRESET)', async () => {
      const resetError = new Error('ECONNRESET');
      resetError.code = 'ECONNRESET';
      resetError.errno = 'ECONNRESET';
      axiosMockAdapter.get.mockRejectedValue(resetError);

      const response = await request(app)
        .get(`${baseUrl}/search`)
        .query({ q: 'matrix' })
        .expect(502);

      expect(response.body.error.code).toBe(ErrorCodes.UPSTREAM_CONNECTION_RESET);
    });

    it('should retry on transient network errors with exponential backoff', async () => {
      const transientError = new Error('Transient error');
      transientError.code = 'ETIMEDOUT';
      
      axiosMockAdapter.get
        .mockRejectedValueOnce(transientError)
        .mockRejectedValueOnce(transientError)
        .mockResolvedValue({ data: mockSearchResponse });

      const response = await request(app)
        .get(`${baseUrl}/search`)
        .query({ q: 'matrix' })
        .expect(200);

      expect(axiosMockAdapter.get).toHaveBeenCalledTimes(3);
      expect(response.body.results).toHaveLength(1);
    });

    it('should not retry on non-transient errors (4xx)', async () => {
      const clientError = new Error('Bad Request');
      clientError.response = { status: 400, data: { message: 'Invalid query' } };
      axiosMockAdapter.get.mockRejectedValue(clientError);

      const response = await request(app)
        .get(`${baseUrl}/search`)
        .query({ q: 'matrix' })
        .expect(400);

      expect(axiosMockAdapter.get).toHaveBeenCalledTimes(1);
      expect(response.body.error.code).toBe(ErrorCodes.INVALID_REQUEST);
    });
  });

  describe('GET /api/streams/search - Large Payload Handling', () => {
    const generateLargeResponse = (itemCount) => ({
      results: Array.from({ length: itemCount }, (_, i) => ({
        id: `tt${String(i).padStart(7, '0')}`,
        title: `Movie ${i}`,
        year: 2000 + (i % 20),
        type: 'movie',
        sources: Array.from({ length: 5 }, (_, j) => ({
          name: `Source ${j}`,
          url: `https://source${j}.com/watch/tt${String(i).padStart(7, '0')}`,
          quality: ['4K', 'HD', 'SD'][j % 3]
        })),
        poster: `https://image.tmdb.org/t/p/w500/poster${i}.jpg`,
        imdbId: `tt${String(i).padStart(7, '0')}`,
        overview: 'x'.repeat(500)
      })),
      pagination: { page: 1, limit: itemCount, total: item