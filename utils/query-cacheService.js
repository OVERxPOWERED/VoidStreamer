```javascript
'use strict';

class QueryCacheService {
  constructor(options = {}) {
    this.ttlMs = options.ttlMs ?? 5 * 60 * 1000; // 5 minutes default
    this.maxSize = options.maxSize ?? 1000;
    this.redisClient = options.redisClient ?? null;
    this._useRedis = false;
    this._redisModule = null;

    // LRU cache using Map (maintains insertion order)
    this._cache = new Map();
    this._accessOrder = new Map(); // key -> access timestamp

    // Statistics
    this._stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      evictions: 0,
      invalidations: 0
    };

    // Initialize Redis if client provided
    if (this.redisClient) {
      this._initRedis();
    }

    // Periodic cleanup of expired entries
    this._cleanupInterval = setInterval(() => this._cleanupExpired(), 60 * 1000);
    this._cleanupInterval.unref();
  }

  async _initRedis() {
    try {
      // Dynamic import for optional ioredis dependency
      const Redis = (await import('ioredis')).default;
      this._redisModule = Redis;
      this._useRedis = true;
    } catch (error) {
      // ioredis not available, fallback to in-memory only
      this._useRedis = false;
      this.redisClient = null;
    }
  }

  _generateRedisKey(key) {
    return `querycache:${key}`;
  }

  _isExpired(entry) {
    return Date.now() > entry.expiresAt;
  }

  _updateAccess(key) {
    this._accessOrder.set(key, Date.now());
  }

  _evictLRU() {
    if (this._cache.size >= this.maxSize) {
      // Find least recently used key
      let lruKey = null;
      let lruTime = Infinity;

      for (const [key, time] of this._accessOrder) {
        if (time < lruTime) {
          lruTime = time;
          lruKey = key;
        }
      }

      if (lruKey) {
        this._cache.delete(lruKey);
        this._accessOrder.delete(lruKey);
        this._stats.evictions++;
      }
    }
  }

  _cleanupExpired() {
    const now = Date.now();
    for (const [key, entry] of this._cache) {
      if (now > entry.expiresAt) {
        this._cache.delete(key);
        this._accessOrder.delete(key);
      }
    }
  }

  async get(key) {
    const entry = this._cache.get(key);

    if (!entry) {
      this._stats.misses++;
      // Try Redis if available
      if (this._useRedis && this.redisClient) {
        try {
          const redisKey = this._generateRedisKey(key);
          const data = await this.redisClient.get(redisKey);
          if (data) {
            const parsed = JSON.parse(data);
            this._cache.set(key, parsed);
            this._updateAccess(key);
            this._stats.hits++;
            return parsed.value;
          }
        } catch (error) {
          // Redis error, fallback to miss
        }
      }
      return null;
    }

    if (this._isExpired(entry)) {
      this._cache.delete(key);
      this._accessOrder.delete(key);
      this._stats.misses++;
      return null;
    }

    this._updateAccess(key);
    this._stats.hits++;
    return entry.value;
  }

  async set(key, value, ttlMs = this.ttlMs) {
    const expiresAt = Date.now() + ttlMs;
    const entry = { value, expiresAt, createdAt: Date.now() };

    this._evictLRU();
    this._cache.set(key, entry);
    this._updateAccess(key);
    this._stats.sets++;

    // Write to Redis if available
    if (this._useRedis && this.redisClient) {
      try {
        const redisKey = this._generateRedisKey(key);
        const ttlSeconds = Math.ceil(ttlMs / 1000);
        await this.redisClient.setex(redisKey, ttlSeconds, JSON.stringify(entry));
      } catch (error) {
        // Redis write failed, continue with in-memory only
      }
    }

    return true;
  }

  async invalidate(key) {
    const existed = this._cache.has(key);
    this._cache.delete(key);
    this._accessOrder.delete(key);

    if (existed) {
      this._stats.invalidations++;
    }

    // Invalidate in Redis if available
    if (this._useRedis && this.redisClient) {
      try {
        const redisKey = this._generateRedisKey(key);
        await this.redisClient.del(redisKey);
      } catch (error) {
        // Redis delete failed
      }
    }

    return existed;
  }

  async invalidatePattern(pattern) {
    let count = 0;
    const regex = new RegExp(pattern.replace(/\*/g, '.*'));

    // Invalidate in-memory cache
    for (const key of this._cache.keys()) {
      if (regex.test(key)) {
        this._cache.delete(key);
        this._accessOrder.delete(key);
        count++;
      }
    }

    this._stats.invalidations += count;

    // Invalidate in Redis if available (using SCAN for pattern matching)
    if (this._useRedis && this.redisClient) {
      try {
        const redisPattern = this._generateRedisKey(pattern);
        let cursor = '0';
        do {
          const [newCursor, keys] = await this.redisClient.scan(cursor, 'MATCH', redisPattern, 'COUNT', 100);
          cursor = newCursor;
          if (keys.length > 0) {
            await this.redisClient.del(...keys);
            count += keys.length;
          }
        } while (cursor !== '0');
      } catch (error) {
        // Redis pattern invalidation failed
      }
    }

    return count;
  }

  async clear() {
    const size = this._cache.size;
    this._cache.clear();
    this._accessOrder.clear();

    // Clear Redis if available
    if (this._useRedis && this.redisClient) {
      try {
        const pattern = this._generateRedisKey('*');
        let cursor = '0';
        do {
          const [newCursor, keys] = await this.redisClient.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
          cursor = newCursor;
          if (keys.length > 0) {
            await this.redisClient.del(...keys);
          }
        } while (cursor !== '0');
      } catch (error) {
        // Redis clear failed
      }
    }

    return size;
  }

  async getOrFetch(key, fetcherFn, ttlMs = this.ttlMs) {
    const cached = await this.get(key);
    if (cached !== null) {
      return cached;
    }

    const value = await fetcherFn();
    await this.set(key, value, ttlMs);
    return value;
  }

  getStats() {
    const total = this._stats.hits + this._stats.misses;
    return {
      ...this._stats,
      hitRate: total > 0 ? (this._stats.hits / total) : 0,
      size: this._cache.size,
      maxSize: this.maxSize,
      redisEnabled: this._useRedis
    };
  }

  resetStats() {
    this._stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      evictions: 0,
      invalidations: 0
    };
  }

  getKeys