import StreamScraperService from './stream-scraper-service.js';
import StreamHealthMonitorService from './stream-health-monitor-service.js';
import QueryCacheService from './query-cache-service.js';
import StreamQualityService from './stream-quality-service.js';
import StreamRecordingService from './stream-recording-service.js';
import StreamSchedulerService from './stream-scheduler-service.js';
import MetricsAggregatorService from './metrics-aggregator-service.js';

class StreamServiceOrchestrator {
  #scraperService;
  #healthMonitorService;
  #cacheService;
  #qualityService;
  #recordingService;
  #schedulerService;
  #metricsAggregator;
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
    
    this.#metricsAggregator = new MetricsAggregatorService(
      this.#schedulerService.circuitBreakers,
      this.#cacheService,
      this.#healthMonitorService,
      this.#schedulerService
    );
    
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
    this.#setupMetricsAggregatorEventForwarding();
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

    this.#recordingService.on('recording:completed', (recording) => {
      this.#recordingStreamIds.delete(recording.streamId);
      this.#healthMonitorService.resumeHealthChecks(recording.streamId);
      this.#emit('orchestrator:recording:completed', recording);
    });

    this.#recordingService.on('recording:failed', (error) => {
      this.#emit('orchestrator:recording:failed', error);
    });

    this.#recordingService.on('recording:progress', (progress) => {
      this.#emit('orchestrator:recording:progress', progress);
    });
  }

  #setupMetricsAggregatorEventForwarding() {
    this.#metricsAggregator.on('metricsCollected', (snapshot) => {
      this.#emit('orchestrator:metricsCollected', snapshot);
    });

    this.#metricsAggregator.on('collectionError', (error) => {
      this.#emit('orchestrator:metricsCollectionError', error);
    });
  }

  #emit(event, data) {
    const handlers = this.#eventHandlers.get(event) ?? [];
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
  }

  off(event, handler) {
    const handlers = this.#eventHandlers.get(event);
    if (handlers) {
      const index = handlers.indexOf(handler);
      if (index !== -1) {
        handlers.splice(index, 1);
      }
    }
  }

  async initialize() {
    await this.#healthMonitorService.initialize();
    await this.#schedulerService.initialize();
    this.#metricsAggregator.startCollection(30000);
    this.#healthMonitoringActive = true;
  }

  async shutdown() {
    this.#metricsAggregator.stopCollection();
    await this.#schedulerService.shutdown();
    await this.#healthMonitorService.shutdown();
    await this.#recordingService.stopAllRecordings();
    this.#healthMonitoringActive = false;
    this.#eventHandlers.clear();
  }

  getHealthMetrics() {
    const aggregatorSnapshot = this.#metricsAggregator.getMetricsSnapshot();
    return {
      orchestrator: { ...this.#metrics },
      aggregated: aggregatorSnapshot,
      timestamp: new Date().toISOString()
    };
  }

  getMetricsAggregator() {
    return this.#metricsAggregator;
  }

  // Scraper service delegation
  async scrapeStream(url, options = {}) {
    this.#metrics.totalRequests++;
    try {
      const result = await this.#scraperService.scrape(url, options);
      this.#metrics.scrapes.success++;
      return result;
    } catch (error) {
      this.#metrics.scrapes.failure++;
      throw error;
    }
  }

  // Cache service delegation
  async getCached(key) {
    const result = await this.#cacheService.get(key);
    if (result !== undefined) {
      this.#metrics.cacheHits++;
    } else {
      this.#metrics.cacheMisses++;
    }
    return result;
  }

  async setCache(key, value, ttl) {
    return this.#cacheService.set(key, value, ttl);
  }

  async invalidateCache(pattern) {
    return this.#cacheService.invalidate(pattern);
  }

  getCacheStats() {
    return this.#cacheService.getStats();
  }

  // Health monitor delegation
  async checkStreamHealth(streamId) {
    return this.#healthMonitorService.checkHealth(streamId);
  }

  async checkMultipleStreamHealth(streamIds) {
    return this.#healthMonitorService.checkMultipleHealth(streamIds);
  }

  getHealthMonitorMetrics() {
    return this.#healthMonitorService.getMetrics();
  }

  // Quality service delegation
  async getStreamQuality(streamId, options = {}) {
    this.#metrics.qualityRequests++;
    return this.#qualityService.getQuality(streamId, options);
  }

  // Recording service delegation
  async startRecording(streamId, options = {}) {
    this.#metrics.recordingRequests++;
    return this.#recordingService.startRecording(streamId, options);
  }

  async stopRecording(recordingId) {
    return this.#recordingService.stopRecording(recordingId);
  }

  getRecordingStatus(recordingId) {
    return this.#recordingService.getStatus(recordingId);
  }

  getActiveRecordings() {
    return this.#recordingService.getActiveRecordings();
  }

  // Scheduler service delegation
  addSchedule(schedule) {
    return this.#schedulerService.addSchedule(schedule);
  }

  removeSchedule(scheduleId) {
    return this.#schedulerService.removeSchedule(scheduleId);
  }

  getSchedule(scheduleId) {
    return this.#schedulerService.getSchedule(scheduleId);
  }

  getAllSchedules() {
    return this.#schedulerService.getAllSchedules();
  }

  getSchedulerStats() {
    return this.#schedulerService.getStats();
  }

  // Circuit breaker access
  getCircuitBreakerStates() {
    const states = {};
    for (const [key, breaker] of this.#schedulerService.circuitBreakers) {
      states[key] = breaker.getState();
    }
    return states;
  }

  resetCircuitBreaker(key) {
    const breaker = this.#schedulerService.circuitBreakers.get(key);
    if (breaker) {
      breaker.reset();
      return true;
    }
    return false;
  }

  isHealthMonitoringActive() {
    return this.#healthMonitoringActive;
  }

  getActiveRecordingStreamIds() {
    return Array.from(this.#recordingStreamIds);
  }
}

export default StreamServiceOrchestrator;