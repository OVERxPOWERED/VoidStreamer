const nock = require('nock');
const { StreamScraperService } = require('../../src/services/stream-scraper-service');
const { TelemetryService } = require('../../src/services/telemetry-service');
const { Logger } = require('../../src/utils/logger');
const { CircuitBreaker } = require('../../src/utils/circuit-breaker');

describe('StreamScraperService Integration Tests', () => {
  let scraperService;
  let telemetryService;
  let logger;
  let circuitBreaker;
  const baseUrl = 'https://streams.example.com';
  const testCorrelationId = 'test-correlation-123';

  beforeAll(() => {
    nock.disableNetConnect();
    nock.enableNetConnect('127.0.0.1');
  });

  afterAll(() => {
    nock.enableNetConnect();
    nock.cleanAll();
  });

  beforeEach(() => {
    nock.cleanAll();
    telemetryService = new TelemetryService({ serviceName: 'stream-scraper-test' });
    logger = new Logger({ level: 'debug', correlationId: testCorrelationId });
    circuitBreaker = new CircuitBreaker({
      failureThreshold: 5,
      resetTimeout: 1000,
      halfOpenRequests: 2
    });
    scraperService = new StreamScraperService({
      baseUrl,
      timeout: 5000,
      maxRetries: 3,
      retryBackoff: 100,
      telemetryService,
      logger,
      circuitBreaker
    });
  });

  afterEach(async () => {
    await scraperService.shutdown();
    await telemetryService.shutdown();
  });

  describe('Successful Scrape', () => {
    it('should return parsed stream metadata for valid HTML response', async () => {
      const validHtml = `
        <html>
          <body>
            <div class="stream-list">
              <div class="stream-item" data-id="stream-1">
                <h3 class="stream-title">Test Stream 1</h3>
                <span class="stream-viewers">1,234 viewers</span>
                <span class="stream-category">Gaming</span>
                <a class="stream-url" href="/stream/1">Watch</a>
                <img class="stream-thumbnail" src="/thumb1.jpg" alt="Thumbnail 1" />
              </div>
              <div class="stream-item" data-id="stream-2">
                <h3 class="stream-title">Test Stream 2</h3>
                <span class="stream-viewers">567 viewers</span>
                <span class="stream-category">Music</span>
                <a class="stream-url" href="/stream/2">Watch</a>
                <img class="stream-thumbnail" src="/thumb2.jpg" alt="Thumbnail 2" />
              </div>
            </div>
          </body>
        </html>
      `;

      nock(baseUrl)
        .get('/streams')
        .reply(200, validHtml, { 'Content-Type': 'text/html' });

      const result = await scraperService.scrapeStreams({ correlationId: testCorrelationId });

      expect(result).toBeDefined();
      expect(result.streams).toHaveLength(2);
      expect(result.streams[0]).toMatchObject({
        id: 'stream-1',
        title: 'Test Stream 1',
        viewers: 1234,
        category: 'Gaming',
        url: `${baseUrl}/stream/1`,
        thumbnail: `${baseUrl}/thumb1.jpg`
      });
      expect(result.streams[1]).toMatchObject({
        id: 'stream-2',
        title: 'Test Stream 2',
        viewers: 567,
        category: 'Music',
        url: `${baseUrl}/stream/2`,
        thumbnail: `${baseUrl}/thumb2.jpg`
      });
      expect(result.metadata.correlationId).toBe(testCorrelationId);
      expect(result.metadata.scrapedAt).toBeDefined();
    });

    it('should handle single stream item correctly', async () => {
      const singleStreamHtml = `
        <html>
          <body>
            <div class="stream-list">
              <div class="stream-item" data-id="single-stream">
                <h3 class="stream-title">Single Stream</h3>
                <span class="stream-viewers">42 viewers</span>
                <span class="stream-category">Just Chatting</span>
                <a class="stream-url" href="/stream/single">Watch</a>
              </div>
            </div>
          </body>
        </html>
      `;

      nock(baseUrl)
        .get('/streams')
        .reply(200, singleStreamHtml);

      const result = await scraperService.scrapeStreams({ correlationId: testCorrelationId });

      expect(result.streams).toHaveLength(1);
      expect(result.streams[0].id).toBe('single-stream');
      expect(result.streams[0].viewers).toBe(42);
    });
  });

  describe('Retry Logic on 5xx Errors', () => {
    it('should retry 3 times with exponential backoff on 500 errors', async () => {
      const scope = nock(baseUrl)
        .get('/streams')
        .reply(500, 'Internal Server Error')
        .get('/streams')
        .reply(502, 'Bad Gateway')
        .get('/streams')
        .reply(503, 'Service Unavailable')
        .get('/streams')
        .reply(200, '<html><body><div class="stream-list"></div></body></html>');

      const startTime = Date.now();
      const result = await scraperService.scrapeStreams({ correlationId: testCorrelationId });
      const elapsed = Date.now() - startTime;

      expect(scope.isDone()).toBe(true);
      expect(result.streams).toHaveLength(0);
      expect(elapsed).toBeGreaterThanOrEqual(300); // 100 + 200ms backoff minimum
    });

    it('should fail after max retries exhausted', async () => {
      nock(baseUrl)
        .get('/streams')
        .times(4)
        .reply(500, 'Internal Server Error');

      await expect(scraperService.scrapeStreams({ correlationId: testCorrelationId }))
        .rejects.toThrow('Max retries exceeded');

      const metrics = telemetryService.getMetrics();
      const failureCounter = metrics.counters.find(m => m.name === 'stream_scraper_failures_total');
      expect(failureCounter.value).toBeGreaterThan(0);
    });

    it('should not retry on 4xx client errors', async () => {
      nock(baseUrl)
        .get('/streams')
        .reply(404, 'Not Found');

      await expect(scraperService.scrapeStreams({ correlationId: testCorrelationId }))
        .rejects.toThrow('HTTP 404');

      const metrics = telemetryService.getMetrics();
      const failureCounter = metrics.counters.find(m => m.name === 'stream_scraper_failures_total');
      expect(failureCounter.value).toBe(1);
    });
  });

  describe('Circuit Breaker Transitions', () => {
    it('should open circuit breaker after 5 consecutive failures', async () => {
      nock(baseUrl)
        .get('/streams')
        .times(5)
        .reply(500, 'Internal Server Error');

      for (let i = 0; i < 5; i++) {
        await expect(scraperService.scrapeStreams({ correlationId: testCorrelationId }))
          .rejects.toThrow();
      }

      expect(circuitBreaker.getState()).toBe('open');

      const metrics = telemetryService.getMetrics();
      const cbOpenCounter = metrics.counters.find(m => m.name === 'circuit_breaker_open_total');
      expect(cbOpenCounter.value).toBe(1);
    });

    it('should reject fast when circuit breaker is open', async () => {
      nock(baseUrl)
        .get('/streams')
        .times(5)
        .reply(500, 'Internal Server Error');

      for (let i = 0; i < 5; i++) {
        await expect(scraperService.scrapeStreams({ correlationId: testCorrelationId }))
          .rejects.toThrow();
      }

      const startTime = Date.now();
      await expect(scraperService.scrapeStreams({ correlationId: testCorrelationId }))
        .rejects.toThrow('Circuit breaker is open');
      const elapsed = Date.now() - startTime;

      expect(elapsed).toBeLessThan(100); // Fast rejection
    });

    it('should transition to half-open after reset timeout', async () => {
      nock(baseUrl)
        .get('/streams')
        .times(5)
        .reply(500, 'Internal Server Error');

      for (let i = 0; i < 5; i++) {
        await expect(scraperService.scrapeStreams({ correlationId: testCorrelationId }))
          .rejects.toThrow();
      }

      expect(circuitBreaker.getState()).toBe('open');

      await new Promise(resolve => setTimeout(resolve, 1100));

      expect(circuitBreaker.getState()).toBe('half-open');

      nock(baseUrl)
        .get('/streams')
        .reply(200, '<html><body><div class="stream-list"></div></body></html>');

      const result = await scraperService.scrapeStreams({ correlationId: testCorrelationId });
      expect(result.streams).toHaveLength(0);
      expect(circuitBreaker.getState()).toBe('closed');
    });

    it('should reopen circuit breaker on failure in half-open state', async () => {
      nock(baseUrl)
        .get('/streams')
        .times(5)
        .reply(500, 'Internal Server Error');

      for (let i = 0; i < 5; i++) {
        await expect(scraperService.scrapeStreams({ correlationId: testCorrelationId }))
          .rejects.toThrow();
      }

      await new Promise(resolve => setTimeout(resolve, 1100));

      nock(baseUrl)
        .get('/streams')
        .times(2)
        .reply(500, 'Internal Server Error');

      await expect(scraperService.scrapeStreams({ correlationId: testCorrelationId }))
        .rejects.toThrow();
      await expect(scraperService.scrapeStreams({ correlationId: testCorrelationId }))
        .rejects.toThrow();

      expect(circuitBreaker.getState()).toBe('open');
    });
  });

  describe('Parsing Edge Cases', () => {
    it('should handle missing stream elements gracefully', async () => {
      const malformedHtml = `
        <html>
          <body>
            <div class="stream-list">
              <div class="stream-item" data-id="incomplete-1">
                <h3 class="stream-title">Incomplete Stream</h3>
              </div>
              <div class="stream-item" data-id="incomplete-2">
                <span class="stream-viewers">100 viewers</span>
              </div>
              <div class="stream-item">
                <h3 class="stream-title">No ID Stream</h3>
                <span class="stream-viewers">50 viewers</span>
              </div>
            </div>
          </body>
        </html>
      `;

      nock(baseUrl)
        .get('/streams')
        .reply(200, malformedHtml);

      const result = await scraperService.scrapeStreams({ correlationId: testCorrelationId });

      expect(result.streams).toHaveLength(3);
      expect(result.streams[0].id).toBe('incomplete-1');
      expect(result.streams[0].viewers).toBe(0);
      expect(result.streams[1].id).toBe('incomplete-2');
      expect(result.streams[1].title).toBe('');
      expect(result.streams[2].id).toBe('unknown');
    });

    it('should handle malformed viewer counts', async () => {
      const html = `
        <html>
          <body>
            <div class="stream-list">
              <div class="stream-item" data-id="stream-1">
                <h3 class="stream-title">Stream 1</h3>
                <span class="stream-viewers">1.5K viewers</span>
              </div>
              <div class="stream-item" data-id="stream-2">
                <h3 class="stream-title">Stream 2</h3>
                <span class="stream-viewers">2,345,678 viewers</span>
              </div>
              <div class="stream-item" data-id="stream-3">
                <h3 class="stream-title">Stream 3</h3>
                <span class="stream-viewers">invalid</span>
              </div>
              <div class="stream-item" data-id="stream-4">
                <h3 class="stream-title">Stream 4</h3>
                <span class="stream-viewers"></span>
              </div>
            </div>
          </body>
        </html>
      `;

      nock(baseUrl)
        .get('/streams')
        .reply(200, html);

      const result = await scraperService.scrapeStreams({ correlationId: testCorrelationId });

      expect(result.streams[0].viewers).toBe(1500);
      expect(result.streams[1].viewers).toBe(2345678);
      expect(result.streams[2].viewers).toBe(0);
      expect(result.streams[3].viewers).toBe(0);
    });

    it('should handle empty stream list', async () => {
      const emptyHtml = `
        <html>
          <body>
            <div class="stream-list"></div>
          </body>
        </html>
      `;

      nock(baseUrl)
        .get('/streams')
        .reply(200, emptyHtml);

      const result = await scraperService.scrapeStreams({ correlationId: testCorrelationId });

      expect(result.streams).toHaveLength(0);
      expect(result.metadata.totalFound).toBe(0);
    });

    it('should handle completely malformed HTML', async () => {
      const malformedHtml = 'not html at all {{{';

      nock(baseUrl)
        .get('/streams')
        .reply(200, malformedHtml, { 'Content-Type': 'text/html' });

      const result = await scraperService.scrapeStreams({ correlationId: testCorrelationId });

      expect(result.streams).toHaveLength(0);
    });

    it('should handle missing stream-list container', async () => {
      const html = '<html><body><div class="other-content">No streams here</div></body></html>';

      nock(baseUrl)
        .get('/streams')
        .reply(200, html);

      const result = await scraperService.scrapeStreams({ correlationId: testCorrelationId });

      expect(result.streams).toHaveLength(0);
    });
  });

  describe('Timeout Handling', () => {
    it('should handle connection timeout', async () => {
      nock(baseUrl)
        .get('/streams')
        .delayConnection(6000)
        .reply(200, '<html><body><div class="stream-list"></div></body></html>');

      await expect(scraperService.scrapeStreams({ correlationId: testCorrelationId }))
        .rejects.toThrow(/timeout|ETIMEDOUT|ECONNABORTED/i);

      const metrics = telemetryService.getMetrics();
      const timeoutCounter = metrics.counters.find(m => m.name === 'stream_scraper_timeouts_total');
      expect(timeoutCounter.value).toBe(1);
    });

    it('should handle response timeout', async () => {
      nock(baseUrl)
        .get('/streams')
        .delay(6000)
        .reply(200, '<html><body><div class="stream-list"></div></body></html>');

      await expect(scraperService.scrapeStreams({ correlationId: testCorrelationId }))
        .rejects.toThrow(/timeout|ETIMEDOUT/i);
    });

    it('should respect custom timeout option', async () => {
      const customScraper = new StreamScraperService({
        baseUrl,
        timeout: 100,
        maxRetries: 0,
        telemetryService,
        logger,
        circuitBreaker: new CircuitBreaker({ failureThreshold: 5, resetTimeout: 1000 })
      });

      nock(baseUrl)
        .get('/streams')
        .delay(200)
        .reply(200, '<html><body><div class="stream-list"></div></body></html>');

      await expect(customScraper.scrapeStreams({ correlationId: testCorrelationId }))
        .rejects.toThrow(/timeout/i);

      await customScraper.shutdown();
    });
  });

  describe('Correlation ID Propagation', () => {
    it('should propagate correlation ID through service calls',