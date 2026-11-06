const QueryCacheService = require('../../src/services/query-cache-service');

describe('QueryCacheService Integration Tests', () => {
  let cacheService;

  beforeEach(() => {
    cacheService = new QueryCacheService({
      defaultTTL: 5000,
      maxSize: 100,
      cleanupInterval: 1000
    });
  });

  afterEach(() => {
    cacheService.destroy();
    jest.useRealTimers();
  });

  describe('TTL Expiration', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    test('entries expire after defaultTTL', async () => {
      cacheService.set('key1', 'value1');
      expect(cacheService.get('key1')).toBe('value1');

      jest.advanceTimersByTime(5000);
      expect(cacheService.get('key1')).toBeNull();
    });

    test('per-entry TTL overrides defaultTTL', async () => {
      cacheService.set('key1', 'value1', { ttl: 1000 });
      cacheService.set('key2', 'value2');

      jest.advanceTimersByTime(1500);
      expect(cacheService.get('key1')).toBeNull();
      expect(cacheService.get('key2')).toBe('value2');

      jest.advanceTimersByTime(4000);
      expect(cacheService.get('key2')).toBeNull();
    });

    test('TTL of 0 means no expiration', async () => {
      cacheService.set('key1', 'value1', { ttl: 0 });
      
      jest.advanceTimersByTime(10000);
      expect(cacheService.get('key1')).toBe('value1');
    });

    test('negative TTL uses defaultTTL', async () => {
      cacheService.set('key1', 'value1', { ttl: -1 });
      
      jest.advanceTimersByTime(3000);
      expect(cacheService.get('key1')).toBe('value1');
      
      jest.advanceTimersByTime(3000);
      expect(cacheService.get('key1')).toBeNull();
    });
  });

  describe('LRU Eviction', () => {
    test('evicts least recently used entries when maxSize exceeded', () => {
      const smallCache = new QueryCacheService({ maxSize: 3, defaultTTL: 60000 });
      
      smallCache.set('key1', 'value1');
      smallCache.set('key2', 'value2');
      smallCache.set('key3', 'value3');
      
      expect(smallCache.get('key1')).toBe('value1');
      expect(smallCache.get('key2')).toBe('value2');
      expect(smallCache.get('key3')).toBe('value3');
      
      smallCache.set('key4', 'value4');
      
      expect(smallCache.get('key1')).toBeNull();
      expect(smallCache.get('key2')).toBe('value2');
      expect(smallCache.get('key3')).toBe('value3');
      expect(smallCache.get('key4')).toBe('value4');
      
      smallCache.destroy();
    });

    test('accessing an entry updates its LRU position', () => {
      const smallCache = new QueryCacheService({ maxSize: 3, defaultTTL: 60000 });
      
      smallCache.set('key1', 'value1');
      smallCache.set('key2', 'value2');
      smallCache.set('key3', 'value3');
      
      smallCache.get('key1');
      
      smallCache.set('key4', 'value4');
      
      expect(smallCache.get('key1')).toBe('value1');
      expect(smallCache.get('key2')).toBeNull();
      expect(smallCache.get('key3')).toBe('value3');
      expect(smallCache.get('key4')).toBe('value4');
      
      smallCache.destroy();
    });

    test('setting existing key updates value and LRU position', () => {
      const smallCache = new QueryCacheService({ maxSize: 3, defaultTTL: 60000 });
      
      smallCache.set('key1', 'value1');
      smallCache.set('key2', 'value2');
      smallCache.set('key3', 'value3');
      
      smallCache.set('key1', 'updated-value1');
      
      smallCache.set('key4', 'value4');
      
      expect(smallCache.get('key1')).toBe('updated-value1');
      expect(smallCache.get('key2')).toBeNull();
      expect(smallCache.get('key3')).toBe('value3');
      expect(smallCache.get('key4')).toBe('value4');
      
      smallCache.destroy();
    });

    test('maxSize of 0 means unlimited', () => {
      const unlimitedCache = new QueryCacheService({ maxSize: 0, defaultTTL: 60000 });
      
      for (let i = 0; i < 1000; i++) {
        unlimitedCache.set(`key${i}`, `value${i}`);
      }
      
      expect(unlimitedCache.get('key0')).toBe('value0');
      expect(unlimitedCache.get('key999')).toBe('value999');
      
      unlimitedCache.destroy();
    });
  });

  describe('Hit/Miss Metrics', () => {
    test('getStats() accurately tracks hits and misses', () => {
      cacheService.set('key1', 'value1');
      cacheService.set('key2', 'value2');
      
      cacheService.get('key1');
      cacheService.get('key1');
      cacheService.get('key2');
      cacheService.get('key3');
      cacheService.get('key4');
      
      const stats = cacheService.getStats();
      
      expect(stats.hits).toBe(3);
      expect(stats.misses).toBe(2);
      expect(stats.hitRate).toBeCloseTo(0.6, 2);
      expect(stats.size).toBe(2);
      expect(stats.maxSize).toBe(100);
    });

    test('hitRate is 0 when no requests made', () => {
      const stats = cacheService.getStats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
      expect(stats.hitRate).toBe(0);
    });

    test('hitRate is 1 when all requests hit', () => {
      cacheService.set('key1', 'value1');
      cacheService.get('key1');
      cacheService.get('key1');
      
      const stats = cacheService.getStats();
      expect(stats.hitRate).toBe(1);
    });

    test('stats include eviction count', () => {
      const smallCache = new QueryCacheService({ maxSize: 2, defaultTTL: 60000 });
      
      smallCache.set('key1', 'value1');
      smallCache.set('key2', 'value2');
      smallCache.set('key3', 'value3');
      
      const stats = smallCache.getStats();
      expect(stats.evictions).toBe(1);
      
      smallCache.destroy();
    });

    test('stats include expired count', () => {
      jest.useFakeTimers();
      
      cacheService.set('key1', 'value1', { ttl: 1000 });
      cacheService.set('key2', 'value2', { ttl: 1000 });
      
      jest.advanceTimersByTime(2000);
      
      cacheService.get('key1');
      cacheService.get('key2');
      
      const stats = cacheService.getStats();
      expect(stats.expired).toBe(2);
    });
  });

  describe('Concurrent Access', () => {
    test('multiple rapid gets/sets maintain consistency', async () => {
      const iterations = 100;
      const promises = [];
      
      for (let i = 0; i < iterations; i++) {
        promises.push(
          Promise.resolve().then(() => {
            cacheService.set(`key${i}`, `value${i}`);
            return cacheService.get(`key${i}`);
          })
        );
      }
      
      const results = await Promise.all(promises);
      
      for (let i = 0; i < iterations; i++) {
        expect(results[i]).toBe(`value${i}`);
      }
      
      const stats = cacheService.getStats();
      expect(stats.size).toBe(iterations);
      expect(stats.hits).toBe(iterations);
    });

    test('concurrent reads and writes do not corrupt cache', async () => {
      cacheService.set('shared-key', 'initial');
      
      const writePromises = Array.from({ length: 50 }, (_, i) => 
        Promise.resolve().then(() => cacheService.set('shared-key', `value-${i}`))
      );
      
      const readPromises = Array.from({ length: 50 }, () => 
        Promise.resolve().then(() => cacheService.get('shared-key'))
      );
      
      await Promise.all([...writePromises, ...readPromises]);
      
      const finalValue = cacheService.get('shared-key');
      expect(finalValue).toMatch(/^value-\d+$/);
    });

    test('concurrent operations on different keys are isolated', async () => {
      const keyCount = 50;
      const opsPerKey = 20;
      
      const promises = [];
      for (let keyIdx = 0; keyIdx < keyCount; keyIdx++) {
        for (let opIdx = 0; opIdx < opsPerKey; opIdx++) {
          promises.push(
            Promise.resolve().then(() => {
              const key = `key-${keyIdx}`;
              cacheService.set(key, `value-${keyIdx}-${opIdx}`);
              return cacheService.get(key);
            })
          );
        }
      }
      
      const results = await Promise.all(promises);
      
      for (let keyIdx = 0; keyIdx < keyCount; keyIdx++) {
        for (let opIdx = 0; opIdx < opsPerKey; opIdx++) {
          const idx = keyIdx * opsPerKey + opIdx;
          expect(results[idx]).toBe(`value-${keyIdx}-${opIdx}`);
        }
      }
    });
  });

  describe('Cleanup Interval', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    test('expired entries removed without manual intervention', () => {
      const cleanupCache = new QueryCacheService({
        defaultTTL: 1000,
        maxSize: 100,
        cleanupInterval: 500
      });
      
      cleanupCache.set('key1', 'value1');
      cleanupCache.set('key2', 'value2');
      cleanupCache.set('key3', 'value3');
      
      expect(cleanupCache.getStats().size).toBe(3);
      
      jest.advanceTimersByTime(1500);
      
      jest.advanceTimersByTime(500);
      
      expect(cleanupCache.getStats().size).toBe(0);
      expect(cleanupCache.get('key1')).toBeNull();
      expect(cleanupCache.get('key2')).toBeNull();
      expect(cleanupCache.get('key3')).toBeNull();
      
      cleanupCache.destroy();
    });

    test('cleanup does not remove non-expired entries', () => {
      const cleanupCache = new QueryCacheService({
        defaultTTL: 5000,
        maxSize: 100,
        cleanupInterval: 1000
      });
      
      cleanupCache.set('key1', 'value1');
      cleanupCache.set('key2', 'value2', { ttl: 10000 });
      
      jest.advanceTimersByTime(3000);
      jest.advanceTimersByTime(1000);
      
      expect(cleanupCache.get('key1')).toBeNull();
      expect(cleanupCache.get('key2')).toBe('value2');
      expect(cleanupCache.getStats().size).toBe(1);
      
      cleanupCache.destroy();
    });

    test('cleanup interval of 0 disables automatic cleanup', () => {
      const noCleanupCache = new QueryCacheService({
        defaultTTL: 1000,
        maxSize: 100,
        cleanupInterval: 0
      });
      
      noCleanupCache.set('key1', 'value1');
      
      jest.advanceTimersByTime(2000);
      jest.advanceTimersByTime(1000);
      
      expect(noCleanupCache.getStats().size).toBe(1);
      expect(noCleanupCache.get('key1')).toBeNull();
      
      noCleanupCache.destroy();
    });

    test('manual cleanup removes expired entries', () => {
      const manualCache = new QueryCacheService({
        defaultTTL: 1000,
        maxSize: 100,
        cleanupInterval: 0
      });
      
      manualCache.set('key1', 'value1');
      manualCache.set('key2', 'value2');
      
      jest.advanceTimersByTime(2000);
      
      expect(manualCache.getStats().size).toBe(2);
      
      manualCache.cleanup();
      
      expect(manualCache.getStats().size).toBe(0);
      
      manualCache.destroy();
    });
  });

  describe('Edge Cases', () => {
    test('handles null and undefined values', () => {
      cacheService.set('null-key', null);
      cacheService.set('undefined-key', undefined);
      cacheService.set('zero-key', 0);
      cacheService.set('empty-string-key', '');
      cacheService.set('false-key', false);
      
      expect(cacheService.get('null-key')).toBeNull();
      expect(cacheService.get('undefined-key')).toBeUndefined();
      expect(cacheService.get('zero-key')).toBe(0);
      expect(cacheService.get('empty-string-key')).toBe('');
      expect(cacheService.get('false-key')).toBe(false);
    });

    test('handles complex objects and arrays', () => {
      const obj = { nested: { array: [1, 2, { deep: 'value' }] } };
      const arr = [{ id: 1 }, { id: 2 }];
      
      cacheService.set('object-key', obj);
      cacheService.set('array-key', arr);
      
      expect(cacheService.get('object-key')).toEqual(obj);
      expect(cacheService.get('array-key')).toEqual(arr);
      
      const retrievedObj = cacheService.get('object-key');
      retrievedObj.nested.array[2].deep = 'modified';
      
      expect(cacheService.get('object-key').nested.array[2].deep).toBe('value');
    });

    test('delete removes entry and updates stats', () => {
      cacheService.set('key1', 'value1');
      cacheService.set('key2', 'value2');
      
      expect(cacheService.delete('key1')).toBe(true);
      expect(cacheService.get('key1')).toBeNull();
      expect(cacheService.getStats().size).toBe(1);
      
      expect(cacheService.delete('nonexistent')).toBe(false);
    });

    test('clear removes all entries and resets stats', () => {
      cacheService.set('key1', 'value1');
      cacheService.set('key2', 'value2');
      cacheService.get('key1');
      cacheService.get('key3');
      
      cacheService.clear();
      
      expect(cacheService.getStats().size).toBe(0);
      expect(cacheService.getStats().hits).toBe(0);
      expect(cacheService.getStats().misses).toBe(0);
      expect(cacheService.getStats().evictions).toBe(0);
      expect(cacheService.getStats().expired).toBe(0);
    });

    test('destroy stops cleanup interval and clears cache', () => {
      const destroyCache = new QueryCacheService({
        defaultTTL: 1000,
        cleanupInterval: 100
      });
      
      destroyCache.set('key1', 'value1');
      destroyCache.destroy();
      
      jest.advanceTimersByTime(2000);
      
      expect(destroyCache.get('key1')).toBeNull();
      expect(destroyCache.getStats().size).toBe(0);
    });

    test('has returns true for existing non-expired keys', () => {
      cacheService.set('key1', 'value1');
      cacheService.set('key2', 'value2', { ttl: 1000 });
      
      expect(cacheService.has('key1')).toBe(true);
      expect(cacheService.has('key