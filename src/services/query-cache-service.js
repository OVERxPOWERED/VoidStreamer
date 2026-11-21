class QueryCacheService {
  constructor(options = {}) {
    this.maxSize = options.maxSize ?? 1000;
    this.defaultTTL = options.defaultTTL ?? 300000;
    this.onEvict = options.onEvict ?? null;
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

  getHighResTime() {
    return process.hrtime.bigint();
  }

  msToNano(ms) {
    return BigInt(ms) * 1000000n;
  }

  nanoToMs(nano) {
    return Number(nano / 1000000n);
  }

  set(key, value, ttl) {
    const entryTTL = ttl ?? this.defaultTTL;
    const now = this.getHighResTime();
    const expiresAt = now + this.msToNano(entryTTL);

    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      this.evictLRU();
    }

    this.cache.set(key, {
      value,
      expiresAt,
      createdAt: now,
      accessCount: 0
    });

    return this;
  }

  get(key) {
    const entry = this.cache.get(key);
    const now = this.getHighResTime();

    if (!entry) {
      this.missCount++;
      return null;
    }

    if (now > entry.expiresAt) {
      this.cache.delete(key);
      this.expiredCount++;
      this.missCount++;
      return null;
    }

    this.cache.delete(key);
    entry.accessCount++;
    this.cache.set(key, entry);
    this.hitCount++;
    return entry.value;
  }

  has(key) {
    const entry = this.cache.get(key);
    const now = this.getHighResTime();

    if (!entry) {
      return false;
    }

    if (now > entry.expiresAt) {
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
      const evictedEntry = this.cache.get(firstKey);
      this.cache.delete(firstKey);
      this.evictionCount++;
      if (this.onEvict) {
        try {
          this.onEvict(firstKey, evictedEntry?.value);
        } catch (error) {
          // Silently ignore callback errors to not break cache operations
        }
      }
    }
  }

  cleanupExpired() {
    const now = this.getHighResTime();
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

  getKeys() {
    return Array.from(this.cache.keys());
  }

  getStats() {
    const totalRequests = this.hitCount + this.missCount;
    const hitRate = totalRequests > 0 ? this.hitCount / totalRequests : 0;

    let memoryUsageEstimate = 0;
    for (const [key, entry] of this.cache.entries()) {
      memoryUsageEstimate += key.length * 2;
      memoryUsageEstimate += JSON.stringify(entry.value).length * 2;
      memoryUsageEstimate += 64;
    }

    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hitCount: this.hitCount,
      missCount: this.missCount,
      evictionCount: this.evictionCount,
      expiredCount: this.expiredCount,
      hitRate: Number(hitRate.toFixed(4)),
      memoryUsageEstimate
    };
  }

  destroy() {
    this.stopCleanupInterval();
    this.clear();
  }
}

module.exports = QueryCacheService;