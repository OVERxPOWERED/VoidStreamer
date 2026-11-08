import StreamScraperService from './stream-scraper-service.js';
import StreamHealthMonitorService from './stream-health-monitor-service.js';
import QueryCacheService from './query-cache-service.js';

class StreamServiceOrchestrator {
  #scraperService;
  #healthMonitorService;
  #cacheService;
  #metrics;

  constructor(options = {}) {
    this.#scraperService = options.scraperService ?? new StreamScraperService();
    this.#healthMonitorService = options.healthMonitorService ?? new StreamHealthMonitorService();
    this.#cacheService = options.cacheService ?? new QueryCacheService();
    
    this.#metrics = {
      cacheHits: 0,
      cacheMisses: 0,
      healthChecks: { healthy: 0, unhealthy: 0, errors: 0 },
      scrapes: { success: 0, failure: 0 },
      retries: 0,
      totalRequests: 0
    };
  }

  async getStreamData(url, options = {}) {
    const { ttl = 300000, maxRetries = 3, skipHealthCheck = false } = options;
    this.#metrics.totalRequests++;

    const cacheKey = this.#generateCacheKey(url);
    
    const cached = await this.#cacheService.get(cacheKey);
    if (cached !== null) {
      this.#metrics.cacheHits++;
      return { data: cached, source: 'cache', cached: true };
    }

    this.#metrics.cacheMisses++;

    if (!skipHealthCheck) {
      const healthResult = await this.#healthMonitorService.checkHealth(url);
      if (healthResult.healthy) {
        this.#metrics.healthChecks.healthy++;
      } else {
        this.#metrics.healthChecks.unhealthy++;
        throw new Error(`Stream health check failed: ${healthResult.reason}`);
      }
    }

    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const scrapedData = await this.#scraperService.scrape(url);
        
        await this.#cacheService.set(cacheKey, scrapedData, { ttl });
        
        this.#metrics.scrapes.success++;
        if (attempt > 1) {
          this.#metrics.retries += attempt - 1;
        }
        
        return { data: scrapedData, source: 'scraper', cached: false, attempts: attempt };
      } catch (error) {
        lastError = error;
        this.#metrics.scrapes.failure++;
        
        if (attempt < maxRetries) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
          await this.#sleep(delay);
        }
      }
    }

    throw lastError;
  }

  async invalidateCache(url) {
    const cacheKey = this.#generateCacheKey(url);
    await this.#cacheService.delete(cacheKey);
  }

  getMetrics() {
    const scraperMetrics = this.#scraperService.getMetrics?.() ?? {};
    const healthMetrics = this.#healthMonitorService.getMetrics?.() ?? {};
    const cacheMetrics = this.#cacheService.getMetrics?.() ?? {};

    return {
      orchestrator: { ...this.#metrics },
      scraper: scraperMetrics,
      healthMonitor: healthMetrics,
      cache: cacheMetrics
    };
  }

  #generateCacheKey(url) {
    return `stream:${url}`;
  }

  #sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

const defaultOrchestrator = new StreamServiceOrchestrator();

export { StreamServiceOrchestrator };
export default defaultOrchestrator;