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
  #healthMonitoringActive;
  #recordingStreamIds;

  constructor(options = {}) {
    this.#scraperService = options.scraperService ?? new StreamScraperService();
    this.#healthMonitorService = options.healthMonitorService ?? new StreamHealthMonitorService(options.healthMonitorConfig);
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
    this.#healthMonitoringActive = false;
    this.#recordingStreamIds = new Set();
    
    this.#setupSchedulerEventForwarding();
    this.#setupHealthMonitorEventForwarding();
    this.#setupRecordingCoordination();
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

  #setupHealthMonitorEventForwarding() {
    this.#healthMonitorService.on('healthMetricsUpdated', (metrics) => {
      this.#metrics.healthChecks.healthy = metrics.healthy ?? this.#metrics.healthChecks.healthy;
      this.#metrics.healthChecks.unhealthy = metrics.unhealthy ?? this.#metrics.healthChecks.unhealthy;
      this.#metrics.healthChecks.errors = metrics.errors ?? this.#metrics.healthChecks.errors;
      this.#emit('orchestrator:healthMetricsUpdated', metrics);
    });

    this.#healthMonitorService.on('healthCheckCompleted', (result) => {
      this.#emit('orchestrator:healthCheckCompleted', result);
    });

    this.#healthMonitorService.on('healthCheckError', (error) => {
      this.#metrics.healthChecks.errors++;
      this.#emit('orchestrator:healthCheckError', error);
    });
  }

  #setupRecordingCoordination() {
    this.#recordingService.on('recording:started', (recording) => {
      this.#recordingStreamIds.add(recording.streamId);
      this.#healthMonitorService.pauseHealthChecks(recording.streamId);
      this.#emit('orchestrator:recording:started', recording);
    });

    this.#recordingService.on('recording:stopped', (recording) => {
      this.#recordingStreamIds.delete(recording.streamId);
      this.#healthMonitorService.resumeHealthChecks(recording.streamId);
      this.#emit('orchestrator:recording:stopped', recording);
    });

    this.#recordingService.on('recording:failed', (error) => {
      if (error.streamId) {
        this.#recordingStreamIds.delete(error.streamId);
        this.#healthMonitorService.resumeHealthChecks(error.streamId);
      }
      this.#emit('orchestrator:recording:failed', error);
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
        result.qualities = await this.getStreamQualities(url, { ttl });
      }
      return result;
    }

    this.#metrics.cacheMisses++;
    
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const data = await this.#scraperService.scrapeStream(url);
        this.#metrics.scrapes.success++;
        
        await this.#cacheService.set(cacheKey, data, ttl);
        
        if (!skipHealthCheck) {
          await this.#healthMonitorService.checkStreamHealth(url);
        }
        
        const result = { data, source: 'scraper', cached: false };
        if (includeQualities) {
          result.qualities = await this.getStreamQualities(url, { ttl });
        }
        return result;
      } catch (error) {
        lastError = error;
        this.#metrics.scrapes.failure++;
        this.#metrics.retries++;
        
        if (attempt < maxRetries) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 30000);
          await this.#sleep(delay);
        }
      }
    }
    
    throw lastError;
  }

  async getStreamQualities(url, options = {}) {
    const { ttl = 300000 } = options;
    this.#metrics.qualityRequests++;
    
    const cacheKey = this.#generateQualityCacheKey(url);
    const cached = await this.#cacheService.get(cacheKey);
    if (cached !== null) {
      return cached;
    }
    
    const qualities = await this.#qualityService.getQualities(url);
    await this.#cacheService.set(cacheKey, qualities, ttl);
    return qualities;
  }

  async startRecording(streamId, options = {}) {
    this.#metrics.recordingRequests++;
    return this.#recordingService.startRecording(streamId, options);
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

  addSchedule(schedule) {
    return this.#schedulerService.addSchedule(schedule);
  }

  removeSchedule(scheduleId) {
    return this.#schedulerService.removeSchedule(scheduleId);
  }

  getSchedule(scheduleId) {
    return this.#schedulerService.getSchedule(scheduleId);
  }

  listSchedules() {
    return this.#schedulerService.listSchedules();
  }

  getHealthMetrics() {
    return this.#healthMonitorService.getAllHealthMetrics();
  }

  getStreamHealth(streamId) {
    return this.#healthMonitorService.getHealthMetrics(streamId);
  }

  startHealthMonitoring() {
    if (this.#healthMonitoringActive) {
      return;
    }
    this.#healthMonitoringActive = true;
    this.#healthMonitorService.startMonitoring();
    this.#emit('orchestrator:healthMonitoring:started', {});
  }

  stopHealthMonitoring() {
    if (!this.#healthMonitoringActive) {
      return;
    }
    this.#healthMonitoringActive = false;
    this.#healthMonitorService.stopMonitoring();
    this.#emit('orchestrator:healthMonitoring:stopped', {});
  }

  isHealthMonitoringActive() {
    return this.#healthMonitoringActive;
  }

  getMetrics() {
    return {
      ...this.#metrics,
      healthMonitoringActive: this.#healthMonitoringActive,
      recordingStreamCount: this.#recordingStreamIds.size,
      cacheStats: this.#cacheService.getStats()
    };
  }

  async shutdown() {
    this.stopHealthMonitoring();
    await this.#schedulerService.shutdown();
    await this.#recordingService.stopAllRecordings();
    this.#cacheService.clear();
    this.#eventHandlers.clear();
    this.#emit('orchestrator:shutdown', {});
  }
}

export default StreamServiceOrchestrator;