class QueryCacheService {
  constructor(options = {}) {
    this.maxSize = options.maxSize ?? 1000;
    this.defaultTTL = options.defaultTTL ?? 300000;
    this.cache = new Map();
    this.hitCount = 0;
    this.missCount = 0;
    this.evictionCount = 0;
    this.expiredCount = 0;
    this.cleanupInterval = null;
    this.startCleanupInterval();
  }

  startCleanupInterval() {
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpired();
    }, 60000);
    this.cleanupInterval.unref();
  }

  stopCleanupInterval() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  set(key, value, ttl) {
    const entryTTL = ttl ?? this.defaultTTL;
    const expiresAt = Date.now() + entryTTL;

    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      this.evictLRU();
    }

    this.cache.set(key, {
      value,
      expiresAt,
      createdAt: Date.now()
    });

    return this;
  }

  get(key) {
    const entry = this.cache.get(key);

    if (!entry) {
      this.missCount++;
      return null;
    }

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.expiredCount++;
      this.missCount++;
      return null;
    }

    this.cache.delete(key);
    this.cache.set(key, entry);
    this.hitCount++;
    return entry.value;
  }

  has(key) {
    const entry = this.cache.get(key);

    if (!entry) {
      return false;
    }

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.expiredCount++;
      return false;
    }

    return true;
  }

  delete(key) {
    const existed = this.cache.delete(key);
    return existed;
  }

  clear() {
    this.cache.clear();
    this.hitCount = 0;
    this.missCount = 0;
    this.evictionCount = 0;
    this.expiredCount = 0;
  }

  evictLRU() {
    const firstKey = this.cache.keys().next().value;
    if (firstKey !== undefined) {
      this.cache.delete(firstKey);
      this.evictionCount++;
    }
  }

  cleanupExpired() {
    const now = Date.now();
    let removed = 0;

    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
        removed++;
      }
    }

    this.expiredCount += removed;
    return removed;
  }

  getStats() {
    const totalRequests = this.hitCount + this.missCount;
    const hitRate = totalRequests > 0 ? this.hitCount / totalRequests : 0;

    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hitCount: this.hitCount,
      missCount: this.missCount,
      hitRate: Number(hitRate.toFixed(4)),
      evictionCount: this.evictionCount,
      expiredCount: this.expiredCount
    };
  }

  destroy() {
    this.stopCleanupInterval();
    this.clear();
  }
}

module.exports = QueryCacheService;