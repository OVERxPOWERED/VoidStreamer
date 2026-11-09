import StreamScraperService from './stream-scraper-service.js';
import StreamHealthMonitorService from './stream-health-monitor-service.js';
import QueryCacheService from './query-cache-service.js';
import StreamQualityService from './stream-quality-service.js';
import StreamRecordingService from './stream-recording-service.js';

class StreamServiceOrchestrator {
  #scraperService;
  #healthMonitorService;
  #cacheService;
  #qualityService;
  #recordingService;
  #metrics;

  constructor(options = {}) {
    this.#scraperService = options.scraperService ?? new StreamScraperService();
    this.#healthMonitorService = options.healthMonitorService ?? new StreamHealthMonitorService();
    this.#cacheService = options.cacheService ?? new QueryCacheService();
    this.#qualityService = options.qualityService ?? new StreamQualityService();
    this.#recordingService = options.recordingService ?? new StreamRecordingService();
    
    this.#metrics = {
      cacheHits: 0,
      cacheMisses: 0,
      healthChecks: { healthy: 0, unhealthy: 0, errors: 0 },
      scrapes: { success: 0, failure: 0 },
      retries: 0,
      totalRequests: 0,
      qualityRequests: 0,
      recordingRequests: 0
    };
  }

  async getStreamData(url, options = {}) {
    const { 
      ttl = 300000, 
      maxRetries = 3, 
      skipHealthCheck = false,
      includeQualities = false 
    } = options;
    this.#metrics.totalRequests++;

    const cacheKey = this.#generateCacheKey(url);
    
    const cached = await this.#cacheService.get(cacheKey);
    if (cached !== null) {
      this.#metrics.cacheHits++;
      const result = { data: cached, source: 'cache', cached: true };
      if (includeQualities) {
        result.qualities = await this.getStreamQualities(url, { skipCache: true });
      }
      return result;
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
        
        const result = { data: scrapedData, source: 'scraper', cached: false, attempts: attempt };
        if (includeQualities) {
          result.qualities = await this.getStreamQualities(url, { skipCache: true });
        }
        return result;
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

  async getStreamQualities(streamUrl, options = {}) {
    const { skipCache = false, maxRetries = 2 } = options;
    this.#metrics.qualityRequests++;

    const cacheKey = this.#generateQualityCacheKey(streamUrl);
    
    if (!skipCache) {
      const cached = await this.#cacheService.get(cacheKey);
      if (cached !== null) {
        this.#metrics.cacheHits++;
        return { qualities: cached, source: 'cache', cached: true };
      }
    }

    this.#metrics.cacheMisses++;

    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const qualities = await this.#qualityService.detectQualities(streamUrl);
        
        if (!skipCache) {
          await this.#cacheService.set(cacheKey, qualities, { ttl: 60000 });
        }
        
        return { qualities, source: 'quality-service', cached: false, attempts: attempt };
      } catch (error) {
        lastError = error;
        
        if (attempt < maxRetries) {
          const delay = Math.min(500 * Math.pow(2, attempt - 1), 5000);
          await this.#sleep(delay);
        }
      }
    }

    throw lastError;
  }

  async selectQuality(streamUrl, qualityId, options = {}) {
    const { validateAvailability = true } = options;
    
    if (validateAvailability) {
      const { qualities } = await this.getStreamQualities(streamUrl);
      const quality = qualities.find(q => q.id === qualityId);
      if (!quality) {
        throw new Error(`Quality ${qualityId} not available for stream`);
      }
      if (!quality.available) {
        throw new Error(`Quality ${qualityId} is currently unavailable`);
      }
    }

    const selectedUrl = await this.#qualityService.selectQuality(streamUrl, qualityId);
    
    return {
      streamUrl: selectedUrl,
      qualityId,
      selectedAt: new Date().toISOString()
    };
  }

  async startRecording(streamUrl, options = {}) {
    const { 
      qualityId, 
      duration, 
      outputFormat = 'mp4',
      outputPath,
      segmentDuration = 10 
    } = options;
    
    this.#metrics.recordingRequests++;

    let recordingUrl = streamUrl;
    if (qualityId) {
      const selection = await this.selectQuality(streamUrl, qualityId);
      recordingUrl = selection.streamUrl;
    }

    const recording = await this.#recordingService.startRecording(recordingUrl, {
      outputFormat,
      outputPath,
      duration,
      segmentDuration
    });

    return {
      recordingId: recording.id,
      streamUrl: recordingUrl,
      qualityId,
      status: 'recording',
      startedAt: recording.startedAt,
      options: { outputFormat, duration, segmentDuration }
    };
  }

  async stopRecording(recordingId) {
    const result = await this.#recordingService.stopRecording(recordingId);
    
    return {
      recordingId,
      status: 'stopped',
      stoppedAt: new Date().toISOString(),
      outputPath: result.outputPath,
      duration: result.duration,
      fileSize: result.fileSize
    };
  }

  async getRecordingStatus(recordingId) {
    const status = await this.#recordingService.getRecordingStatus(recordingId);
    
    return {
      recordingId,
      ...status
    };
  }

  async invalidateCache(url) {
    const cacheKey = this.#generateCacheKey(url);
    const qualityCacheKey = this.#generateQualityCacheKey(url);
    await Promise.all([
      this.#cacheService.delete(cacheKey),
      this.#cacheService.delete(qualityCacheKey)
    ]);
  }

  getMetrics() {
    const scraperMetrics = this.#scraperService.getMetrics?.() ?? {};
    const healthMetrics = this.#healthMonitorService.getMetrics?.() ?? {};
    const cacheMetrics = this.#cacheService.getMetrics?.() ?? {};
    const qualityMetrics = this.#qualityService.getMetrics?.() ?? {};
    const recordingMetrics = this.#recordingService.getMetrics?.() ?? {};

    return {
      orchestrator: { ...this.#metrics },
      scraper: scraperMetrics,
      healthMonitor: healthMetrics,
      cache: cacheMetrics,
      quality: qualityMetrics,
      recording: recordingMetrics
    };
  }

  #generateCacheKey(url) {
    return `stream:${url}`;
  }

  #generateQualityCacheKey(url) {
    return `stream:qualities:${url}`;
  }

  #sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

const defaultOrchestrator = new StreamServiceOrchestrator();

export { StreamServiceOrchestrator };
export default defaultOrchestrator;