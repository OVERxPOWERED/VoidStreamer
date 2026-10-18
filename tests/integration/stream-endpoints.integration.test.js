const request = require('supertest');
const express = require('express');
const streamEndpoints = require('../../src/api/stream-endpoints');
const { StreamDomainError, ErrorCodes } = require('../../src/domain/errors');

describe('Stream Endpoints Integration Tests', () => {
  let app;
  let server;

  beforeAll(async () => {
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
  });

  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  const baseUrl = '/api/streams';

  describe('GET /api/streams/search', () => {
    describe('Valid query parameters', () => {
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
    });

    describe('Empty and missing query parameters', () => {
      it('should return 400 when query parameter is missing', async () => {
        const response = await request(app)
          .get(`${baseUrl}/search`)
          .expect('Content-Type', /json/)
          .expect(400);

        expect(response.body).toMatchObject({
          error: expect.objectContaining({
            code: ErrorCodes.VALIDATION_ERROR,
            message: expect.stringContaining('query')
          })
        });
      });

      it('should return 400 when query parameter is empty string', async () => {
        const response = await request(app)
          .get(`${baseUrl}/search`)
          .query({ q: '' })
          .expect(400);

        expect(response.body.error.code).toBe(ErrorCodes.VALIDATION_ERROR);
      });

      it('should return 400 when query parameter is whitespace only', async () => {
        const response = await request(app)
          .get(`${baseUrl}/search`)
          .query({ q: '   ' })
          .expect(400);

        expect(response.body.error.code).toBe(ErrorCodes.VALIDATION_ERROR);
      });

      it('should use default pagination when not provided', async () => {
        const response = await request(app)
          .get(`${baseUrl}/search`)
          .query({ q: 'test' })
          .expect(200);

        expect(response.body.pagination.page).toBe(1);
        expect(response.body.pagination.limit).toBe(20);
      });
    });

    describe('Special characters and injection attempts', () => {
      it('should handle special characters in query safely', async () => {
        const response = await request(app)
          .get(`${baseUrl}/search`)
          .query({ q: 'test@#$%^&*()' })
          .expect(200);

        expect(response.body).toHaveProperty('results');
      });

      it('should handle SQL injection attempts safely', async () => {
        const sqlPayloads = [
          "' OR '1'='1",
          "'; DROP TABLE streams; --",
          "1' UNION SELECT * FROM users --",
          "' OR 1=1 --"
        ];

        for (const payload of sqlPayloads) {
          const response = await request(app)
            .get(`${baseUrl}/search`)
            .query({ q: payload })
            .expect(200);

          expect(response.body).toHaveProperty('results');
          expect(Array.isArray(response.body.results)).toBe(true);
        }
      });

      it('should handle XSS payloads safely', async () => {
        const xssPayloads = [
          '<script>alert(1)</script>',
          '<img src=x onerror=alert(1)>',
          'javascript:alert(1)',
          '<svg onload=alert(1)>',
          '"><script>alert(1)</script>'
        ];

        for (const payload of xssPayloads) {
          const response = await request(app)
            .get(`${baseUrl}/search`)
            .query({ q: payload })
            .expect(200);

          expect(response.body).toHaveProperty('results');
          const responseText = JSON.stringify(response.body);
          expect(responseText).not.toContain('<script>');
          expect(responseText).not.toContain('onerror=');
          expect(responseText).not.toContain('onload=');
        }
      });

      it('should handle unicode and emoji characters', async () => {
        const response = await request(app)
          .get(`${baseUrl}/search`)
          .query({ q: '🎬测试тест' })
          .expect(200);

        expect(response.body).toHaveProperty('results');
      });
    });

    describe('Pagination boundary edge cases', () => {
      it('should return 400 for page less than 1', async () => {
        const response = await request(app)
          .get(`${baseUrl}/search`)
          .query({ q: 'test', page: 0 })
          .expect(40