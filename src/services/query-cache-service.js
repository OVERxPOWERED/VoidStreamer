const { CACHE_TTL_MS } = require('../config/environment');

class QueryCacheService {
  constructor() {
    this.cache = new Map();
    this.accessOrder = new Map();
    this.maxSize = 1000;
    this.defaultTtl = CACHE_TTL_MS || 300000;
  }

  get(key) {
    const entry = this.cache.get(key);
    if (!entry) {
      return null;
    }

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.accessOrder.delete(key);
      return null;
    }

    this.accessOrder.set(key, Date.now());
    return entry.value;
  }

  set(key, value, ttl = this.defaultTtl) {
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      this.evictLRU();
    }

    const expiresAt = Date.now() + ttl;
    this.cache.set(key, { value, expiresAt });
    this.accessOrder.set(key, Date.now());
  }

  invalidate(pattern) {
    const regex = new RegExp(pattern);
    for (const key of this.cache.keys()) {
      if (regex.test(key)) {
        this.cache.delete(key);
        this.accessOrder.delete(key);
      }
    }
  }

  clear() {
    this.cache.clear();
    this.accessOrder.clear();
  }

  evictLRU() {
    let oldestKey = null;
    let oldestTime = Infinity;

    for (const [key, time] of this.accessOrder.entries()) {
      if (time < oldestTime) {
        oldestTime = time;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
      this.accessOrder.delete(oldestKey);
    }
  }

  generateStreamSearchKey(query, quality, sourceIds, page, limit) {
    const sortedSources = [...sourceIds].sort().join(',');
    return `stream:search:${query}:${quality}:${sortedSources}:${page}:${limit}`;
  }

  getStats() {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hitRate: this.hitRate || 0
    };
  }
}

const queryCacheService = new QueryCacheService();

module.exports = { QueryCacheService, queryCacheService };