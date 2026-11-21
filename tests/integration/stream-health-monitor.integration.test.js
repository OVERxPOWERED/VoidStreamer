const StreamHealthMonitorService = require('../../src/services/stream-health-monitor-service');
const CircuitBreaker = require('../../src/utils/circuit-breaker');
const QueryCacheService = require('../../src/services/query-cache-service');
const StreamScraperService = require('../../src/services/stream-scraper-service');
const EventEmitter = require('events');

jest.mock('../../src/services/stream-scraper-service');
jest.mock('../../src/utils/circuit-breaker');
jest.mock('../../src/services/query-cache-service');

describe('StreamHealthMonitorService Integration', () => {
  let monitorService;
  let mockScraperService;
  let mockCircuitBreaker;
  let mockQueryCache;
  let emittedEvents;

  beforeAll(() => {
    emittedEvents = [];
    
    mockScraperService = {
      checkStreamHealth: jest.fn(),
      getStreamMetadata: jest.fn(),
    };
    
    mockCircuitBreaker = {
      isOpen: jest.fn().mockReturnValue(false),
      recordSuccess: jest.fn(),
      recordFailure: jest.fn(),
      getState: jest.fn().mockReturnValue('closed'),
      on: jest.fn((event, handler) => {
        if (event === 'stateChange') {
          mockCircuitBreaker.stateChangeHandler = handler;
        }
      }),
      reset: jest.fn(),
    };
    
    mockQueryCache = {
      get: jest.fn(),
      set: jest.fn(),
      has: jest.fn(),
      delete: jest.fn(),
      clear: jest.fn(),
      getStats: jest.fn().mockReturnValue({ hitCount: 0, missCount: 0, size: 0 }),
      on: jest.fn(),
    };

    StreamScraperService.mockImplementation(() => mockScraperService);
    CircuitBreaker.mockImplementation(() => mockCircuitBreaker);
    QueryCacheService.mockImplementation(() => mockQueryCache);

    monitorService = new StreamHealthMonitorService({
      checkInterval: 100,
      maxConcurrentChecks: 3,
      circuitBreakerThreshold: 5,
      circuitBreakerTimeout: 5000,
      cacheTTL: 60000,
      streams: [
        { id: 'stream-1', url: 'http://stream1.example.com', name: 'Stream 1' },
        { id: 'stream-2', url: 'http://stream2.example.com', name: 'Stream 2' },
        { id: 'stream-3', url: 'http://stream3.example.com', name: 'Stream 3' },
      ],
    });

    monitorService.on('health-change', (event) => {
      emittedEvents.push(event);
    });
  });

  afterAll(async () => {
    if (monitorService) {
      await monitorService.stop();
    }
    jest.clearAllMocks();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    emittedEvents.length = 0;
    
    mockCircuitBreaker.isOpen.mockReturnValue(false);
    mockCircuitBreaker.getState.mockReturnValue('closed');
    mockCircuitBreaker.recordSuccess.mockClear();
    mockCircuitBreaker.recordFailure.mockClear();
    mockCircuitBreaker.reset.mockClear();
    
    mockQueryCache.get.mockReset();
    mockQueryCache.set.mockReset();
    mockQueryCache.has.mockReset();
    mockQueryCache.getStats.mockReturnValue({ hitCount: 0, missCount: 0, size: 0 });
    
    mockScraperService.checkStreamHealth.mockReset();
    mockScraperService.getStreamMetadata.mockReset();
  });

  describe('Circuit Breaker Integration', () => {
    test('respects circuit breaker open state after threshold failures', async () => {
      const streamId = 'stream-1';
      const failureResponse = { healthy: false, latency: 0, error: 'Connection timeout' };
      
      mockScraperService.checkStreamHealth.mockResolvedValue(failureResponse);
      
      for (let i = 0; i < 5; i++) {
        await monitorService.checkStream(streamId);
      }
      
      expect(mockCircuitBreaker.recordFailure).toHaveBeenCalledTimes(5);
      expect(mockCircuitBreaker.isOpen).toHaveBeenCalled();
      
      mockCircuitBreaker.isOpen.mockReturnValue(true);
      mockCircuitBreaker.getState.mockReturnValue('open');
      
      const cachedHealth = { healthy: true, latency: 120, lastChecked: Date.now() - 1000 };
      mockQueryCache.get.mockReturnValue(cachedHealth);
      mockQueryCache.has.mockReturnValue(true);
      
      const result = await monitorService.checkStream(streamId);
      
      expect(result).toEqual(cachedHealth);
      expect(mockScraperService.checkStreamHealth).toHaveBeenCalledTimes(5);
      expect(mockQueryCache.get).toHaveBeenCalledWith(`health:${streamId}`);
    });

    test('circuit breaker transitions to half-open after timeout', async () => {
      const streamId = 'stream-1';
      
      mockCircuitBreaker.isOpen.mockReturnValue(true);
      mockCircuitBreaker.getState.mockReturnValue('open');
      
      jest.advanceTimersByTime(6000);
      
      mockCircuitBreaker.getState.mockReturnValue('half-open');
      mockScraperService.checkStreamHealth.mockResolvedValue({ healthy: true, latency: 100 });
      
      const result = await monitorService.checkStream(streamId);
      
      expect(result.healthy).toBe(true);
      expect(mockCircuitBreaker.recordSuccess).toHaveBeenCalled();
    });
  });

  describe('Cache Integration', () => {
    test('serves cached health results within TTL', async () => {
      const streamId = 'stream-1';
      const cachedHealth = { 
        healthy: true, 
        latency: 150, 
        lastChecked: Date.now() - 5000,
        streamId 
      };
      
      mockQueryCache.has.mockReturnValue(true);
      mockQueryCache.get.mockReturnValue(cachedHealth);
      mockQueryCache.getStats.mockReturnValue({ hitCount: 1, missCount: 0, size: 1 });
      
      const result1 = await monitorService.checkStream(streamId);
      const result2 = await monitorService.checkStream(streamId);
      const result3 = await monitorService.checkStream(streamId);
      
      expect(result1).toEqual(cachedHealth);
      expect(result2).toEqual(cachedHealth);
      expect(result3).toEqual(cachedHealth);
      expect(mockQueryCache.get).toHaveBeenCalledTimes(3);
      expect(mockScraperService.checkStreamHealth).not.toHaveBeenCalled();
      
      const stats = mockQueryCache.getStats();
      expect(stats.hitCount).toBeGreaterThanOrEqual(1);
    });

    test('cache miss triggers fresh health check', async () => {
      const streamId = 'stream-1';
      const freshHealth = { healthy: true, latency: 200, lastChecked: Date.now(), streamId };
      
      mockQueryCache.has.mockReturnValue(false);
      mockQueryCache.get.mockReturnValue(null);
      mockScraperService.checkStreamHealth.mockResolvedValue(freshHealth);
      mockQueryCache.getStats.mockReturnValue({ hitCount: 0, missCount: 1, size: 1 });
      
      const result = await monitorService.checkStream(streamId);
      
      expect(result).toEqual(freshHealth);
      expect(mockScraperService.checkStreamHealth).toHaveBeenCalledWith(streamId);
      expect(mockQueryCache.set).toHaveBeenCalledWith(`health:${streamId}`, freshHealth, 60000);
    });

    test('cache expiration triggers fresh check after TTL', async () => {
      const streamId = 'stream-1';
      const staleHealth = { 
        healthy: true, 
        latency: 100, 
        lastChecked: Date.now() - 70000,
        streamId 
      };
      const freshHealth = { healthy: true, latency: 120, lastChecked: Date.now(), streamId };
      
      mockQueryCache.has.mockReturnValue(true);
      mockQueryCache.get.mockReturnValue(staleHealth);
      mockScraperService.checkStreamHealth.mockResolvedValue(freshHealth);
      
      jest.advanceTimersByTime(70000);
      
      const result = await monitorService.checkStream(streamId);
      
      expect(result).toEqual(freshHealth);
      expect(mockScraperService.checkStreamHealth).toHaveBeenCalled();
    });
  });

  describe('Health State Transitions', () => {
    test('emits health-change events on status transitions healthy->degraded->unhealthy', async () => {
      const streamId = 'stream-1';
      
      mockScraperService.checkStreamHealth
        .mockResolvedValueOnce({ healthy: true, latency: 100, streamId })
        .mockResolvedValueOnce({ healthy: false, latency: 5000, streamId, degraded: true })
        .mockResolvedValueOnce({ healthy: false, latency: 0, streamId, error: 'Timeout' });
      
      await monitorService.checkStream(streamId);
      await monitorService.checkStream(streamId);
      await monitorService.checkStream(streamId);
      
      const healthChangeEvents = emittedEvents.filter(e => e.streamId === streamId);
      expect(healthChangeEvents).toHaveLength(3);
      
      expect(healthChangeEvents[0]).toMatchObject({
        streamId,
        previousStatus: 'unknown',
        currentStatus: 'healthy',
        timestamp: expect.any(Number),
      });
      
      expect(healthChangeEvents[1]).toMatchObject({
        streamId,
        previousStatus: 'healthy',
        currentStatus: 'degraded',
        timestamp: expect.any(Number),
      });
      
      expect(healthChangeEvents[2]).toMatchObject({
        streamId,
        previousStatus: 'degraded',
        currentStatus: 'unhealthy',
        timestamp: expect.any(Number),
      });
    });

    test('emits recovery event when stream returns to healthy', async () => {
      const streamId = 'stream-1';
      
      mockScraperService.checkStreamHealth
        .mockResolvedValueOnce({ healthy: false, latency: 0, streamId, error: 'Down' })
        .mockResolvedValueOnce({ healthy: true, latency: 150, streamId });
      
      await monitorService.checkStream(streamId);
      await monitorService.checkStream(streamId);
      
      const healthChangeEvents = emittedEvents.filter(e => e.streamId === streamId);
      expect(healthChangeEvents).toHaveLength(2);
      
      expect(healthChangeEvents[1]).toMatchObject({
        streamId,
        previousStatus: 'unhealthy',
        currentStatus: 'healthy',
        timestamp: expect.any(Number),
      });
    });

    test('does not emit duplicate events for same status', async () => {
      const streamId = 'stream-1';
      
      mockScraperService.checkStreamHealth
        .mockResolvedValue({ healthy: true, latency: 100, streamId });
      
      await monitorService.checkStream(streamId);
      await monitorService.checkStream(streamId);
      await monitorService.checkStream(streamId);
      
      const healthChangeEvents = emittedEvents.filter(e => e.streamId === streamId);
      expect(healthChangeEvents).toHaveLength(1);
    });
  });

  describe('Concurrent Check Limiting', () => {
    test('limits concurrent checks to maxConcurrentChecks', async () => {
      const checkDelay = 50;
      let activeChecks = 0;
      let maxActiveChecks = 0;
      
      mockScraperService.checkStreamHealth.mockImplementation(async () => {
        activeChecks++;
        maxActiveChecks = Math.max(maxActiveChecks, activeChecks);
        await new Promise(resolve => setTimeout(resolve, checkDelay));
        activeChecks--;
        return { healthy: true, latency: 100 };
      });
      
      const streamIds = ['stream-1', 'stream-2', 'stream-3', 'stream-4', 'stream-5'];
      const promises = streamIds.map(id => monitorService.checkStream(id));
      
      await Promise.all(promises);
      
      expect(maxActiveChecks).toBeLessThanOrEqual(3);
    });

    test('queues excess checks when at concurrency limit', async () => {
      const checkDelay = 30;
      const startTimes = [];
      const endTimes = [];
      
      mockScraperService.checkStreamHealth.mockImplementation(async (streamId) => {
        startTimes.push({ streamId, time: Date.now() });
        await new Promise(resolve => setTimeout(resolve, checkDelay));
        endTimes.push({ streamId, time: Date.now() });
        return { healthy: true, latency: 100 };
      });
      
      const streamIds = ['stream-1', 'stream-2', 'stream-3', 'stream-4', 'stream-5', 'stream-6'];
      await Promise.all(streamIds.map(id => monitorService.checkStream(id)));
      
      const firstBatch = startTimes.slice(0, 3);
      const secondBatch = startTimes.slice(3);
      
      expect(firstBatch.length).toBe(3);
      expect(secondBatch.length).toBe(3);
      
      const firstBatchEnd = Math.max(...firstBatch.map(s => s.time));
      const secondBatchStart = Math.min(...secondBatch.map(s => s.time));
      
      expect(secondBatchStart).toBeGreaterThanOrEqual(firstBatchEnd - 10);
    });
  });

  describe('Health Report Metrics', () => {
    test('getHealthReport returns accurate aggregated metrics', async () => {
      mockScraperService.checkStreamHealth
        .mockResolvedValueOnce({ healthy: true, latency: 100, streamId: 'stream-1' })
        .mockResolvedValueOnce({ healthy: true, latency: 150, streamId: 'stream-2' })
        .mockResolvedValueOnce({ healthy: false, latency: 0, streamId: 'stream-3', error: 'Down' });
      
      await monitorService.checkStream('stream-1');
      await monitorService.checkStream('stream-2');
      await monitorService.checkStream('stream-3');
      
      const report = monitorService.getHealthReport();
      
      expect(report).toMatchObject({
        totalStreams: 3,
        healthyCount: 2,
        degradedCount: 0,
        unhealthyCount: 1,
        uptimePercentage: expect.closeTo(66.67, 1),
        averageLatency: expect.closeTo(125, 10),
        checksPerformed: 3,
        cacheHitRate: expect.any(Number),
        circuitBreakerState: 'closed',
      });
    });

    test('getHealthReport calculates uptimePercentage correctly over time', async () => {
      const streamId = 'stream-1';
      
      for (let i = 0; i < 10; i++) {
        mockScraperService.checkStreamHealth.mockResolvedValueOnce({ 
          healthy: i < 7, 
          latency: 100, 
          streamId 
        });
        await monitorService.checkStream(streamId);
      }
      
      const report = monitorService.getHealthReport();
      
      expect(report.uptimePercentage).toBeCloseTo(70, 1);
      expect(report.checksPerformed).toBe(10);
    });

    test('getHealthReport includes per-stream details', async () => {
      mockScraperService.checkStreamHealth
        .mockResolvedValueOnce({ healthy: true, latency: 100, streamId: 'stream-1' })
        .mockResolvedValueOnce({ healthy: false, latency: 0, streamId: 'stream-2', error: 'Timeout' });
      
      await monitorService.checkStream('stream-1');
      await monitorService.checkStream('stream-2');
      
      const report = monitorService.getHealthReport();
      
      expect(report.streams).toHaveLength(2);
      expect(report.streams[0]).toMatchObject({
        id: 'stream-1',
        name: 'Stream 1',
        status: 'healthy',
        latency: 100,
        uptime: expect.any(Number),
      });
      expect(report.streams[1]).toMatchObject({
        id: 'stream-2',
        name: 'Stream 2',
        status: 'unhealthy',
        latency: 0,
        uptime: expect.any(Number),
        lastError: 'Timeout',
      });
    });
  });

  describe('Graceful Shutdown', () => {
    test('graceful shutdown clears intervals and stops checks', async () => {
      const checkSpy = jest.spyOn(monitorService, 'checkStream');
      
      mockScraperService.checkStreamHealth.mockResolvedValue({ healthy: true, latency: 100 });
      
      await monitorService.start();
      
      await new Promise(resolve => setTimeout(resolve, 250));
      
      expect(checkSpy).toHaveBeenCalled();
      
      await monitorService.stop();
      
      const callsBeforeStop = checkSpy.mock.calls.length;
      
      await new Promise(resolve => setTimeout(resolve, 250));