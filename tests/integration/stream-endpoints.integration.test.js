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
          sources: expect.arrayContaining([
            expect.objectContaining({
              name: expect.any(String),
              url: expect.stringMatching(/^https?:\/\//),
              quality: expect.stringMatching(/^(4K|HD|SD|CAM)$/)
            })
          ]),
          poster: expect.stringMatching(/^https?:\/\//),
          imdbId: expect.stringMatching(/^tt\d+$/)
        });
      }
    });

    it('should handle pagination parameters correctly', async () => {
      const response = await request(app)
        .get(`${baseUrl}/search`)
        .query({ q: 'star wars', page: 2, limit: 20 })
        .expect(200);

      expect(response.body.pagination.page).toBe(2);
      expect(response.body.pagination.limit).toBe(20);
    });

    it('should default to page=1, limit=10 when not provided', async () => {
      const response = await request(app)
        .get(`${baseUrl}/search`)
        .query({ q: 'batman' })
        .expect(200);

      expect(response.body.pagination.page).toBe(1);
      expect(response.body.pagination.limit).toBe(10);
    });

    it('should return empty results for no matches', async () => {
      axiosMockAdapter.get.mockResolvedValueOnce({ data: mockEmptyResponse });
      
      const response = await request(app)
        .get(`${baseUrl}/search`)
        .query({ q: 'nonexistentmovie12345' })
        .expect(200);

      expect(response.body.results).toEqual([]);
      expect(response.body.pagination.total).toBe(0);
    });

    it('should handle special characters in query', async () => {
      axiosMockAdapter.get.mockResolvedValueOnce({ data: mockSearchResponse });
      
      const response = await request(app)
        .get(`${baseUrl}/search`)
        .query({ q: "l'homme qui rit" })
        .expect(200);

      expect(response.body.results.length).toBeGreaterThan(0);
    });
  });

  describe('GET /api/streams/search - Invalid Input Sanitization', () => {
    const xssPayloads = [
      '<script>alert("xss")</script>',
      '"><script>alert(1)</script>',
      'javascript:alert(1)',
      '<img src=x onerror=alert(1)>',
      '<svg onload=alert(1)>',
      '"><iframe src=javascript:alert(1)>',
      '${alert(1)}',
      '{{7*7}}',
      '<%= 7*7 %>'
    ];

    const sqlInjectionPayloads = [
      "' OR '1'='1",
      "'; DROP TABLE users; --",
      "' UNION SELECT * FROM users --",
      "1' OR '1'='1' --",
      "admin'--",
      "' OR 1=1#",
      "'; EXEC xp_cmdshell('dir'); --"
    ];

    const pathTraversalPayloads = [
      '../../../etc/passwd',
      '..\\..\\..\\windows\\system32\\drivers\\etc\\hosts',
      '%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd',
      '....//....//....//etc/passwd'
    ];

    const commandInjectionPayloads = [
      '; cat /etc/passwd',
      '| cat /etc/passwd',
      '`cat /etc/passwd`',
      '$(cat /etc/passwd)',
      '; rm -rf /',
      '&& cat /etc/passwd'
    ];

    it.each(xssPayloads)('should sanitize XSS payload: %s', async (payload) => {
      axiosMockAdapter.get.mockResolvedValueOnce({ data: mockEmptyResponse });
      
      const response = await request(app)
        .get(`${baseUrl}/search`)
        .query({ q: payload })
        .expect(200);

      expect(response.body.results).toEqual([]);
      expect(axiosMockAdapter.get).toHaveBeenCalledWith(
        expect.stringContaining(encodeURIComponent(payload.replace(/[<>'"]/g, '')))
      );
    });

    it.each(sqlInjectionPayloads)('should sanitize SQL injection payload: %s', async (payload) => {
      axiosMockAdapter.get.mockResolvedValueOnce({ data: mockEmptyResponse });
      
      const response = await request(app)
        .get(`${baseUrl}/search`)
        .query({ q: payload })
        .expect(200);

      expect(response.body.results).toEqual([]);
    });

    it.each(pathTraversalPayloads)('should sanitize path traversal payload: %s', async (payload) => {
      axiosMockAdapter.get.mockResolvedValueOnce({ data: mockEmptyResponse });
      
      const response = await request(app)
        .get(`${baseUrl}/search`)
        .query({ q: payload })
        .expect(200);

      expect(response.body.results).toEqual([]);
    });

    it.each(commandInjectionPayloads)('should sanitize command injection payload: %s', async (payload) => {
      axiosMockAdapter.get.mockResolvedValueOnce({ data: mockEmptyResponse });
      
      const response = await request(app)
        .get(`${baseUrl}/search`)
        .query({ q: payload })
        .expect(200);

      expect(response.body.results).toEqual([]);
    });

    it('should reject empty query', async () => {
      const response = await request(app)
        .get(`${baseUrl}/search`)
        .query({ q: '' })
        .expect(400);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error.code).toBe(ErrorCodes.VALIDATION_ERROR);
    });

    it('should reject query exceeding max length', async () => {
      const longQuery = 'a'.repeat(501);
      const response = await request(app)
        .get(`${baseUrl}/search`)
        .query({ q: longQuery })
        .expect(400);

      expect(response.body.error.code).toBe(ErrorCodes.VALIDATION_ERROR);
    });

    it('should reject invalid page parameter', async () => {
      const response = await request(app)
        .get(`${baseUrl}/search`)
        .query({ q: 'matrix', page: -1 })
        .expect(400);

      expect(response.body.error.code).toBe(ErrorCodes.VALIDATION_ERROR);
    });

    it('should reject invalid limit parameter', async () => {
      const response = await request(app)
        .get(`${baseUrl}/search`)
        .query({ q: 'matrix', limit: 101 })
        .expect(400);

      expect(response.body.error.code).toBe(ErrorCodes.VALIDATION_ERROR);
    });

    it('should reject non-numeric page/limit', async () => {
      const response = await request(app)
        .get(`${baseUrl}/search`)
        .query({ q: 'matrix', page: 'abc', limit: 'xyz' })
        .expect(400);

      expect(response.body.error.code).toBe(ErrorCodes.VALIDATION_ERROR);
    });
  });

  describe('GET /api/streams/search - Rate Limiting', () => {
    beforeEach(() => {
      axiosMockAdapter.get.mockResolvedValue({ data: mockSearchResponse });
    });

    it('should return 429 when rate limit exceeded', async () => {
      const rateLimitError = new Error('Rate Limited');
      rateLimitError.response = {
        status: 429,
        headers: { 'retry-after': '60' },
        data: { error: 'Too Many Requests' }
      };
      rateLimitError.isAxiosError = true;
      axiosMockAdapter.get.mockRejectedValueOnce(rateLimitError);

      const response = await request(app)
        .get(`${baseUrl}/search`)
        .query({ q: 'matrix' })
        .expect(429);

      expect(response.body.error.code).toBe(ErrorCodes.RATE_LIMITED);
      expect(response.headers).toHaveProperty('retry-after');
      expect(telemetryService.recordError).toHaveBeenCalledWith(
        expect.objectContaining({ code: ErrorCodes.RATE_LIMITED })
      );
    });

    it('should respect retry-after header', async () => {
      const rateLimitError = new Error('Rate Limited');
      rateLimitError.response = {
        status: 429,
        headers: { 'retry-after': '30' },
        data: { error: 'Too Many Requests' }
      };
      rateLimitError.isAxiosError = true;
      axiosMockAdapter.get.mockRejectedValueOnce(rateLimitError);

      const response = await request(app)
        .get(`${baseUrl}/search`)
        .query({ q: 'matrix' })
        .expect(429);

      expect(response.headers['retry-after']).toBe('30');
    });

    it('should handle rate limit without retry-after header', async () => {
      const rateLimitError = new Error('Rate Limited');
      rateLimitError.response = {
        status: 429,
        headers: {},
        data: { error: 'Too Many Requests' }
      };
      rateLimitError.isAxiosError = true;
      axiosMockAdapter.get.mockRejectedValueOnce(rateLimitError);

      const response = await request(app)
        .get(`${baseUrl}/search`)
        .query({ q: 'matrix' })
        .expect(429);

      expect(response.body.error.code).toBe(ErrorCodes.RATE_LIMITED);
    });

    it('should track rate limit metrics', async () => {
      const rateLimitError = new Error('Rate Limited');
      rateLimitError.response = {
        status: 429,
        headers: { 'retry-after': '60' },
        data: { error: 'Too Many Requests' }
      };
      rateLimitError.isAxiosError = true;
      axiosMockAdapter.get.mockRejectedValueOnce(rateLimitError);

      await request(app)
        .get(`${baseUrl}/search`)
        .query({ q: 'matrix' })
        .expect(429);

      expect(telemetryService.recordMetric).toHaveBeenCalledWith(
        'stream.rate_limited',
        expect.objectContaining({ endpoint: '/search' })
      );
    });
  });

  describe('GET /api/streams/search - Cache Behavior', () => {
    it('should return cached response on cache hit', async () => {
      axiosMockAdapter.get.mockResolvedValue({ data: mockSearchResponse });

      await request(app)
        .get(`${baseUrl}/search`)
        .query({ q: 'matrix' })
        .expect(200);

      axiosMockAdapter.get.mockClear();

      const response = await request(app)
        .get(`${baseUrl}/search`)
        .query({ q: 'matrix' })
        .expect(200);

      expect(axiosMockAdapter.get).not.toHaveBeenCalled();
      expect(response.body.results).toEqual(mockSearchResponse.results);
    });

    it('should fetch fresh data on cache miss', async () => {
      axiosMockAdapter.get.mockResolvedValue({ data: mockSearchResponse });

      const response1 = await request(app)
        .get(`${baseUrl}/search`)
        .query({ q: 'matrix' })
        .expect(200);

      const response2