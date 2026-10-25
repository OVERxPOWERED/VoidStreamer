```javascript
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
  });

  afterAll(async () => {
    await queryCacheService.shutdown();
    await new Promise(resolve => server.close(resolve));
    jest.clearAllMocks();
  });

  beforeEach(() => {
    queryCacheService.clear();
    jest.clearAllMocks();
    telemetryService.recordError.mockReset();
    telemetryService.recordMetric.mockReset();
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

  describe('GET /api/streams/search - Valid query parameters', () => {
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
      expect(response.body.pagination).toMatchObject({
        page: expect.any(Number),
        limit: expect.any(Number),
        total: expect.any(Number),
        totalPages: expect.any(Number)
      });
    });

    it('should return results with correct schema', async () => {
      const response = await request(app)
        .get(`${baseUrl}/search`)
        .query({ q: 'inception' })
        .expect(200);

      expect(validateResponseSchema(response.body, 'StreamSearchResponse')).toBe(true);
      
      if (response.body.results.length > 0) {
        const stream = response.body.results[0];
        expect(stream).toMatchObject({
          id: expect.any(String),
          title: expect.any(String),
          year: expect.any(Number),
          type: expect.stringMatching(/^(movie|series)$/),
          sources: expect.any(Array),
          poster: expect.any(String),
          imdbId: expect.any(String)
        });
        expect(stream.sources[0]).toMatchObject({
          name: expect.any(String),
          url: expect.stringMatching(/^https?:\/\//),
          quality: expect.stringMatching(/^(SD|HD|4K)$/)
        });
      }
    });

    it('should handle pagination correctly', async () => {
      const response = await request(app)
        .get(`${baseUrl}/search`)
        .query({ q: 'star', page: 2, limit: 5 })
        .expect(200);

      expect(response.body.pagination.page).toBe(2);
      expect(response.body.pagination.limit).toBe(5);
    });

    it('should respect maximum limit', async () => {
      const response = await request(app)
        .get(`${baseUrl}/search`)
        .query({ q: 'test', limit: 100 })
        .expect(200);

      expect(response.body.pagination.limit).toBeLessThanOrEqual(50);
    });

    it('should return cache headers on cache hit', async () => {
      await request(app).get(`${baseUrl}/search`).query({ q: 'matrix' }).expect(200);
      
      const response = await request(app)
        .get(`${baseUrl}/search`)
        .query({ q: 'matrix' })
        .expect(200);

      expect(response.headers).toHaveProperty('x-cache', 'HIT');
      expect(response.headers).toHaveProperty('x-cache-ttl');
    });

    it('should return cache miss header on first request', async () => {
      const response = await request(app)
        .get(`${baseUrl}/search`)
        .query({ q: 'unique-query-' + Date.now() })
        .expect(200);

      expect(response.headers).toHaveProperty('x-cache', 'MISS');
    });
  });

  describe('GET /api/streams/search - Empty and missing query parameters', () => {
    it('should return 400 when query parameter is missing', async () => {
      const response = await request(app)
        .get(`${baseUrl}/search`)
        .expect('Content-Type', /json/)
        .expect(400);

      expect(response.body).toMatchObject({
        error: expect.objectContaining({