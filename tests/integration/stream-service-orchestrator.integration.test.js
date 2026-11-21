const axios = require('axios');
const cheerio = require('cheerio');
const StreamServiceOrchestrator = require('../../src/services/StreamServiceOrchestrator');
const QueryCacheService = require('../../src/services/QueryCacheService');
const StreamHealthMonitorService = require('../../src/services/StreamHealthMonitorService');
const StreamScraperService = require('../../src/services/StreamScraperService');

jest.mock('axios');
jest.mock('cheerio');

describe('StreamServiceOrchestrator Integration Tests', () => {
  let orchestrator;
  let cacheService;
  let healthMonitor;
  let scraperService;
  const testQuery = 'test movie 2024';
  const testSources = ['source1', 'source2'];

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    cacheService = new QueryCacheService({ ttl: 60000, maxSize: 100 });
    healthMonitor = new StreamHealthMonitorService({
      checkInterval: 30000,
      timeout: 5000,
      failureThreshold: 3,
      recoveryTimeout: 10000
    });
    scraperService = new StreamScraperService({
      timeout: 10000,
      maxRetries: 3,
      retryDelay: 1000
    });

    orchestrator = new StreamServiceOrchestrator({
      cache: cacheService,
      healthMonitor: healthMonitor,
      scraper: scraperService,
      enableCache: true,
      enableHealthCheck: true
    });

    axios.get.mockReset();
    cheerio.load.mockReset();
  });

  afterEach(async () => {
    await orchestrator.shutdown();
    cacheService.stopCleanupInterval();
    healthMonitor.stopCleanupInterval();
    healthMonitor.resetCircuitBreakers();
    jest.useRealTimers();
  });

  describe('Cache-first strategy', () => {
    it('should return cached data without health check or scrape calls on cache hit', async () => {
      const cachedData = [{ title: 'Test Movie', url: 'http://test.com/stream', quality: '1080p' }];
      cacheService.set(testQuery, cachedData);

      const healthCheckSpy = jest.spyOn(healthMonitor, 'checkHealth');
      const scrapeSpy = jest.spyOn(scraperService, 'scrape');

      const result = await orchestrator.search(testQuery, testSources);

      expect(result).toEqual(cachedData);
      expect(healthCheckSpy).not.toHaveBeenCalled();
      expect(scrapeSpy).not.toHaveBeenCalled();
    });

    it('should trigger full flow on cache miss', async () => {
      const mockStreams = [{ title: 'Test Movie', url: 'http://test.com/stream', quality: '1080p', source: 'source1' }];
      
      healthMonitor.checkHealth = jest.fn().mockResolvedValue({ healthy: true, latency: 50 });
      scraperService.scrape = jest.fn().mockResolvedValue(mockStreams);

      const result = await orchestrator.search(testQuery, testSources);

      expect(result).toEqual(mockStreams);
      expect(healthMonitor.checkHealth).toHaveBeenCalledWith(testSources);
      expect(scraperService.scrape).toHaveBeenCalledWith(testQuery, testSources);
      expect(cacheService.get(testQuery)).toEqual(mockStreams);
    });

    it('should bypass cache when enableCache is false', async () => {
      const noCacheOrchestrator = new StreamServiceOrchestrator({
        cache: cacheService,
        healthMonitor: healthMonitor,
        scraper: scraperService,
        enableCache: false,
        enableHealthCheck: true
      });

      const mockStreams = [{ title: 'Test Movie', url: 'http://test.com/stream', quality: '1080p', source: 'source1' }];
      healthMonitor.checkHealth = jest.fn().mockResolvedValue({ healthy: true, latency: 50 });
      scraperService.scrape = jest.fn().mockResolvedValue(mockStreams);

      cacheService.set(testQuery, [{ title: 'Cached', url: 'http://cached.com', quality: '720p' }]);

      const result = await noCacheOrchestrator.search(testQuery, testSources);

      expect(result).toEqual(mockStreams);
      expect(scraperService.scrape).toHaveBeenCalled();
      await noCacheOrchestrator.shutdown();
    });
  });

  describe('Health check gating', () => {
    it('should skip scraping for unhealthy sources and return error', async () => {
      healthMonitor.checkHealth = jest.fn().mockResolvedValue({
        healthy: false,
        latency: 0,
        error: 'Connection timeout'
      });
      const scrapeSpy = jest.spyOn(scraperService, 'scrape');

      await expect(orchestrator.search(testQuery, testSources))
        .rejects.toThrow('All sources unhealthy');

      expect(scrapeSpy).not.toHaveBeenCalled();
    });

    it('should only scrape healthy sources when some are unhealthy', async () => {
      const mixedHealth = {
        source1: { healthy: true, latency: 50 },
        source2: { healthy: false, latency: 0, error: 'Timeout' }
      };
      healthMonitor.checkHealth = jest.fn().mockResolvedValue(mixedHealth);
      
      const mockStreams = [{ title: 'Test Movie', url: 'http://source1.com/stream', quality: '1080p', source: 'source1' }];
      scraperService.scrape = jest.fn().mockResolvedValue(mockStreams);

      const result = await orchestrator.search(testQuery, ['source1', 'source2']);

      expect(result).toEqual(mockStreams);
      expect(scraperService.scrape).toHaveBeenCalledWith(testQuery, ['source1']);
    });

    it('should bypass health check when enableHealthCheck is false', async () => {
      const noHealthOrchestrator = new StreamServiceOrchestrator({
        cache: cacheService,
        healthMonitor: healthMonitor,
        scraper: scraperService,
        enableCache: true,
        enableHealthCheck: false
      });

      const mockStreams = [{ title: 'Test Movie', url: 'http://test.com/stream', quality: '1080p', source: 'source1' }];
      scraperService.scrape = jest.fn().mockResolvedValue(mockStreams);
      const healthSpy = jest.spyOn(healthMonitor, 'checkHealth');

      const result = await noHealthOrchestrator.search(testQuery, testSources);

      expect(result).toEqual(mockStreams);
      expect(healthSpy).not.toHaveBeenCalled();
      await noHealthOrchestrator.shutdown();
    });
  });

  describe('Retry with exponential backoff', () => {
    it('should retry scraper on failure with exponential backoff', async () => {
      healthMonitor.checkHealth = jest.fn().mockResolvedValue({ healthy: true, latency: 50 });
      
      const mockStreams = [{ title: 'Test Movie', url: 'http://test.com/stream', quality: '1080p', source: 'source1' }];
      const scrapeMock = jest.fn()
        .mockRejectedValueOnce(new Error('Network error'))
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce(mockStreams);
      scraperService.scrape = scrapeMock;

      const resultPromise = orchestrator.search(testQuery, testSources);

      await jest.runAllTimersAsync();
      const result = await resultPromise;

      expect(result).toEqual(mockStreams);
      expect(scrapeMock).toHaveBeenCalledTimes(3);
    });

    it('should fail after max retries exhausted', async () => {
      healthMonitor.checkHealth = jest.fn().mockResolvedValue({ healthy: true, latency: 50 });
      
      const scrapeMock = jest.fn().mockRejectedValue(new Error('Persistent network error'));
      scraperService.scrape = scrapeMock;

      await expect(orchestrator.search(testQuery, testSources))
        .rejects.toThrow('Persistent network error');

      expect(scrapeMock).toHaveBeenCalledTimes(3);
    });

    it('should use increasing delays between retries', async () => {
      healthMonitor.checkHealth = jest.fn().mockResolvedValue({ healthy: true, latency: 50 });
      
      const delays = [];
      let callCount = 0;
      const scrapeMock = jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount < 3) {
          const start = Date.now();
          return new Promise((_, reject) => {
            setTimeout(() => {
              delays.push(Date.now() - start);
              reject(new Error('Network error'));
            }, 100 * callCount);
          });
        }
        return Promise.resolve([{ title: 'Test', url: 'http://test.com', quality: '1080p', source: 'source1' }]);
      });
      scraperService.scrape = scrapeMock;

      const resultPromise = orchestrator.search(testQuery, testSources);
      await jest.runAllTimersAsync();
      await resultPromise;

      expect(delays.length).toBe(2);
      expect(delays[1]).toBeGreaterThan(delays[0]);
    });
  });

  describe('Circuit breaker integration', () => {
    it('should respect open circuit breaker from health monitor', async () => {
      healthMonitor.recordFailure('source1');
      healthMonitor.recordFailure('source1');
      healthMonitor.recordFailure('source1');
      
      const healthCheckSpy = jest.spyOn(healthMonitor, 'checkHealth');
      const scrapeSpy = jest.spyOn(scraperService, 'scrape');

      await expect(orchestrator.search(testQuery, ['source1']))
        .rejects.toThrow('Circuit breaker open for source1');

      expect(healthCheckSpy).not.toHaveBeenCalled();
      expect(scrapeSpy).not.toHaveBeenCalled();
    });

    it('should allow requests when circuit breaker is half-open', async () => {
      healthMonitor.recordFailure('source1');
      healthMonitor.recordFailure('source1');
      healthMonitor.recordFailure('source1');
      
      jest.advanceTimersByTime(11000);
      
      healthMonitor.checkHealth = jest.fn().mockResolvedValue({ healthy: true, latency: 50 });
      const mockStreams = [{ title: 'Test Movie', url: 'http://test.com/stream', quality: '1080p', source: 'source1' }];
      scraperService.scrape = jest.fn().mockResolvedValue(mockStreams);

      const result = await orchestrator.search(testQuery, ['source1']);

      expect(result).toEqual(mockStreams);
    });

    it('should trip circuit breaker after repeated health check failures', async () => {
      healthMonitor.checkHealth = jest.fn()
        .mockResolvedValueOnce({ healthy: false, latency: 0, error: 'Timeout' })
        .mockResolvedValueOnce({ healthy: false, latency: 0, error: 'Timeout' })
        .mockResolvedValueOnce({ healthy: false, latency: 0, error: 'Timeout' });

      await expect(orchestrator.search(testQuery, ['source1'])).rejects.toThrow();
      await expect(orchestrator.search(testQuery, ['source1'])).rejects.toThrow();
      await expect(orchestrator.search(testQuery, ['source1'])).rejects.toThrow();

      await expect(orchestrator.search(testQuery, ['source1']))
        .rejects.toThrow('Circuit breaker open for source1');
    });
  });

  describe('Cache invalidation', () => {
    it('should evict cache entry on invalidateCache', async () => {
      const cachedData = [{ title: 'Test Movie', url: 'http://test.com/stream', quality: '1080p' }];
      cacheService.set(testQuery, cachedData);

      expect(cacheService.get(testQuery)).toEqual(cachedData);

      orchestrator.invalidateCache(testQuery);

      expect(cacheService.get(testQuery)).toBeUndefined();
    });

    it('should re-fetch data after cache invalidation', async () => {
      const initialData = [{ title: 'Test Movie', url: 'http://test.com/stream', quality: '1080p' }];
      const updatedData = [{ title: 'Test Movie Updated', url: 'http://test.com/stream2', quality: '4K' }];
      
      cacheService.set(testQuery, initialData);
      
      healthMonitor.checkHealth = jest.fn().mockResolvedValue({ healthy: true, latency: 50 });
      scraperService.scrape = jest.fn().mockResolvedValue(updatedData);

      orchestrator.invalidateCache(testQuery);
      const result = await orchestrator.search(testQuery, testSources);

      expect(result).toEqual(updatedData);
      expect(scraperService.scrape).toHaveBeenCalled();
    });

    it('should invalidate all cache entries when no query provided', async () => {
      cacheService.set('query1', [{ title: 'Movie 1' }]);
      cacheService.set('query2', [{ title: 'Movie 2' }]);
      cacheService.set('query3', [{ title: 'Movie 3' }]);

      orchestrator.invalidateCache();

      expect(cacheService.get('query1')).toBeUndefined();
      expect(cacheService.get('query2')).toBeUndefined();
      expect(cacheService.get('query3')).toBeUndefined();
    });
  });

  describe('Metrics aggregation', () => {
    it('should return combined metrics from all services', async () => {
      const mockStreams = [{ title: 'Test Movie', url: 'http://test.com/stream', quality: '1080p', source: 'source1' }];
      
      healthMonitor.checkHealth = jest.fn().mockResolvedValue({ healthy: true, latency: 50 });
      scraperService.scrape = jest.fn().mockResolvedValue(mockStreams);

      await orchestrator.search(testQuery, testSources);
      await orchestrator.search(testQuery, testSources);
      await orchestrator.search('another query', testSources);

      const metrics = orchestrator.getMetrics();

      expect(metrics).toHaveProperty('cache');
      expect(metrics.cache).toHaveProperty('hits');
      expect(metrics.cache).toHaveProperty('misses');
      expect(metrics.cache).toHaveProperty('hitRate');
      expect(metrics.cache.hits).toBe(1);
      expect(metrics.cache.misses).toBe(2);
      expect(metrics.cache.hitRate).toBeCloseTo(0.333, 2);

      expect(metrics).toHaveProperty('health');
      expect(metrics.health).toHaveProperty('checks');
      expect(metrics.health).toHaveProperty('healthy');
      expect(metrics.health).toHaveProperty('unhealthy');

      expect(metrics).toHaveProperty('scraper');
      expect(metrics.scraper).toHaveProperty('attempts');
      expect(metrics.scraper).toHaveProperty('successes');
      expect(metrics.scraper).toHaveProperty('failures');
      expect(metrics.scraper).toHaveProperty('retries');
    });

    it('should track cache hit rate correctly', async () => {
      const mockStreams = [{ title: 'Test', url: 'http://test.com', quality: '1080p', source: 'source1' }];
      healthMonitor.checkHealth = jest.fn().mockResolvedValue({ healthy: true, latency: 50 });
      scraperService.scrape = jest.fn().mockResolvedValue(mockStreams);

      await orchestrator.search('query1', testSources);
      await orchestrator.search('query1', testSources);
      await orchestrator.search('query1', testSources);
      await orchestrator.search('query2', testSources);

      const metrics = orchestrator.getMetrics();
      expect(metrics.cache.hits).toBe(2);
      expect(metrics.cache.misses).toBe(2);
      expect(metrics.cache.hitRate).toBe(0.5);
    });

    it('should track scraper retries in metrics', async () => {
      healthMonitor.checkHealth = jest.fn().mockResolvedValue({ healthy: true, latency: 50 });
      
      const mockStreams = [{ title: 'Test', url: 'http://test.com', quality: '1080p', source: 'source1' }];
      scraperService.scrape = jest.fn()
        .mockRejectedValueOnce(new Error('Error'))
        .mockResolvedValueOnce(mockStreams);

      await orchestrator.search(testQuery, testSources);

      const metrics = orchestrator.getMetrics();
      expect(metrics.scraper.attempts).toBe(2);
      expect(metrics.scraper.successes).toBe(1);
      expect(metrics.scraper.failures).toBe(1);
      expect(metrics.scraper.retries).toBe(1);
    });
  });

  describe('Error handling', () => {
    it('should throw NetworkError for axios network failures', async () => {
      healthMonitor.checkHealth = jest.fn().mockResolvedValue({ healthy: true, latency: 50 });
      scraperService.scrape