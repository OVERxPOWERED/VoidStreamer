import StreamScraperService from './stream-scraper-service.js';
import StreamHealthMonitorService from './stream-health-monitor-service.js';
import QueryCacheService from './query-cache-service.js';
import StreamQualityService from './stream-quality-service.js';
import StreamRecordingService from './stream-recording-service.js';
import StreamSchedulerService from './stream-scheduler-service.js';

class StreamServiceOrchestrator {
  #scraperService;
  #healthMonitorService;
  #cacheService;
  #qualityService;
  #recordingService;
  #schedulerService;
  #metrics;
  #eventHandlers;

  constructor(options = {}) {
    this.#scraperService = options.scraperService ?? new StreamScraperService();
    this.#healthMonitorService = options.healthMonitorService ?? new StreamHealthMonitorService();
    this.#cacheService = options.cacheService ?? new QueryCacheService();
    this.#qualityService = options.qualityService ?? new StreamQualityService();
    this.#recordingService = options.recordingService ?? new StreamRecordingService();
    
    const schedulerConfig = options.schedulerConfig ?? {
      maxConcurrentRecordings: 3,
      defaultRetryAttempts: 3,
      defaultRetryDelay: 5000,
      timezone: 'UTC'
    };
    this.#schedulerService = new StreamSchedulerService(this.#recordingService, schedulerConfig);
    
    this.#metrics = {
      cacheHits: 0,
      cacheMisses: 0,
      healthChecks: { healthy: 0, unhealthy: 0, errors: 0 },
      scrapes: { success: 0, failure: 0 },
      retries: 0,
      totalRequests: 0,
      qualityRequests: 0,
      recordingRequests: 0,
      schedulerEvents: { triggered: 0, completed: 0, failed: 0 }
    };
    
    this.#eventHandlers = new Map();
    this.#setupSchedulerEventForwarding();
  }

  #setupSchedulerEventForwarding() {
    this.#schedulerService.on('schedule:triggered', (schedule) => {
      this.#metrics.schedulerEvents.triggered++;
      this.#emit('scheduler:schedule:triggered', schedule);
    });
    
    this.#schedulerService.on('schedule:completed', (result) => {
      this.#metrics.schedulerEvents.completed++;
      this.#emit('scheduler:schedule:completed', result);
    });
    
    this.#schedulerService.on('schedule:failed', (error) => {
      this.#metrics.schedulerEvents.failed++;
      this.#emit('scheduler:schedule:failed', error);
    });
    
    this.#schedulerService.on('schedule:added', (schedule) => {
      this.#emit('scheduler:schedule:added', schedule);
    });
    
    this.#schedulerService.on('schedule:removed', (scheduleId) => {
      this.#emit('scheduler:schedule:removed', scheduleId);
    });
  }

  #emit(event, data) {
    const handlers = this.#eventHandlers.get(event) || [];
    for (const handler of handlers) {
      try {
        handler(data);
      } catch (error) {
        console.error(`Error in event handler for ${event}:`, error);
      }
    }
  }

  on(event, handler) {
    if (!this.#eventHandlers.has(event)) {
      this.#eventHandlers.set(event, []);
    }
    this.#eventHandlers.get(event).push(handler);
    return () => this.off(event, handler);
  }

  off(event, handler) {
    const handlers = this.#eventHandlers.get(event) || [];
    const index = handlers.indexOf(handler);
    if (index !== -1) {
      handlers.splice(index, 1);
    }
  }

  #generateCacheKey(url) {
    return `stream:${url}`;
  }

  #generateQualityCacheKey(url) {
    return `quality:${url}`;
  }

  #sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
          await this.#sleep(delay);
        }
      }
    }

    throw lastError;
  }

  async startRecording(streamUrl, options = {}) {
    this.#metrics.recordingRequests++;
    return this.#recordingService.startRecording(streamUrl, options);
  }

  async stopRecording(recordingId) {
    return this.#recordingService.stopRecording(recordingId);
  }

  getRecordingStatus(recordingId) {
    return this.#recordingService.getRecordingStatus(recordingId);
  }

  listRecordings() {
    return this.#recordingService.listRecordings();
  }

  addRecordingSchedule(scheduleConfig) {
    return this.#schedulerService.addSchedule(scheduleConfig);
  }

  removeRecordingSchedule(scheduleId) {
    return this.#schedulerService.removeSchedule(scheduleId);
  }

  listRecordingSchedules() {
    return this.#schedulerService.listSchedules();
  }

  getSchedule(scheduleId) {
    return this.#schedulerService.getSchedule(scheduleId);
  }

  enableSchedule(scheduleId) {
    return this.#schedulerService.enableSchedule(scheduleId);
  }

  disableSchedule(scheduleId) {
    return this.#schedulerService.disableSchedule(scheduleId);
  }

  triggerSchedule(scheduleId) {
    return this.#schedulerService.triggerSchedule(scheduleId);
  }

  getSchedulerStats() {
    return this.#schedulerService.getStats();
  }

  getStatus() {
    const schedulerStats = this.#schedulerService.getStats();
    return {
      metrics: { ...this.#metrics },
      cache: this.#cacheService.getStats(),
      healthMonitor: this.#healthMonitorService.getStats(),
      qualityService: this.#qualityService.getStats(),
      recordingService: this.#recordingService.getStats(),
      scheduler: {
        pending: schedulerStats.pending,
        running: schedulerStats.running,
        totalSchedules: schedulerStats.totalSchedules,
        enabledSchedules: schedulerStats.enabledSchedules,
        completedToday: schedulerStats.completedToday,
        failedToday: schedulerStats.failedToday
      },
      uptime: process.uptime()
    };
  }

  async shutdown() {
    await this.#schedulerService.shutdown();
    await this.#recordingService.shutdown();
    await this.#cacheService.clear();
    this.#eventHandlers.clear();
  }
}

export default StreamServiceOrchestrator;