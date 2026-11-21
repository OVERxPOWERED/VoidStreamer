const EventEmitter = require('events');
const fs = require('fs').promises;
const path = require('path');
const cron = require('node-cron');
const { StreamRecordingService } = require('./stream-recording-service');
const { StreamQuality, StreamProtocol, RecordingStatus } = require('../types/stream-types');

class Semaphore {
  constructor(maxConcurrent) {
    this.maxConcurrent = maxConcurrent;
    this.current = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.current < this.maxConcurrent) {
      this.current++;
      return true;
    }

    return new Promise((resolve) => {
      this.queue.push(resolve);
    });
  }

  release() {
    this.current--;
    if (this.queue.length > 0) {
      this.current++;
      const next = this.queue.shift();
      next(true);
    }
  }

  getAvailable() {
    return this.maxConcurrent - this.current;
  }

  getQueueLength() {
    return this.queue.length;
  }
}

class StreamSchedulerService extends EventEmitter {
  constructor(config = {}) {
    super();
    this.persistencePath = config.persistencePath || path.join(process.cwd(), 'data', 'schedules.json');
    this.maxConcurrentRecordings = config.maxConcurrentRecordings || 3;
    this.defaultQuality = config.defaultQuality || StreamQuality.HD_720P;
    
    this.schedules = new Map();
    this.cronJobs = new Map();
    this.semaphore = new Semaphore(this.maxConcurrentRecordings);
    this.recordingService = new StreamRecordingService();
    this.isShuttingDown = false;
    
    this._setupEventHandlers();
  }

  _setupEventHandlers() {
    this.recordingService.on('recording:started', (data) => {
      this.emit('schedule:recording-started', data);
    });

    this.recordingService.on('recording:completed', (data) => {
      this.emit('schedule:recording-completed', data);
    });

    this.recordingService.on('recording:failed', (data) => {
      this.emit('schedule:recording-failed', data);
    });

    this.recordingService.on('recording:progress', (data) => {
      this.emit('schedule:recording-progress', data);
    });
  }

  async initialize() {
    await this._loadSchedules();
    await this._startAllSchedules();
    this.emit('scheduler:initialized', { scheduleCount: this.schedules.size });
  }

  async _loadSchedules() {
    try {
      const data = await fs.readFile(this.persistencePath, 'utf-8');
      const schedules = JSON.parse(data);
      
      for (const schedule of schedules) {
        const deserialized = this._deserializeSchedule(schedule);
        this.schedules.set(deserialized.id, deserialized);
      }
      
      this.emit('schedules:loaded', { count: this.schedules.size });
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.emit('scheduler:error', { operation: 'load', error: error.message });
        throw error;
      }
      this.emit('schedules:loaded', { count: 0 });
    }
  }

  _deserializeSchedule(data) {
    return {
      id: data.id,
      name: data.name,
      streamUrl: data.streamUrl,
      cronExpression: data.cronExpression,
      quality: data.quality || this.defaultQuality,
      protocol: data.protocol || StreamProtocol.HLS,
      duration: data.duration || 3600,
      outputPath: data.outputPath,
      enabled: data.enabled !== false,
      metadata: data.metadata || {},
      createdAt: new Date(data.createdAt),
      updatedAt: new Date(data.updatedAt),
      lastRun: data.lastRun ? new Date(data.lastRun) : null,
      nextRun: data.nextRun ? new Date(data.nextRun) : null,
      runCount: data.runCount || 0
    };
  }

  _serializeSchedule(schedule) {
    return {
      id: schedule.id,
      name: schedule.name,
      streamUrl: schedule.streamUrl,
      cronExpression: schedule.cronExpression,
      quality: schedule.quality,
      protocol: schedule.protocol,
      duration: schedule.duration,
      outputPath: schedule.outputPath,
      enabled: schedule.enabled,
      metadata: schedule.metadata,
      createdAt: schedule.createdAt.toISOString(),
      updatedAt: schedule.updatedAt.toISOString(),
      lastRun: schedule.lastRun?.toISOString() || null,
      nextRun: schedule.nextRun?.toISOString() || null,
      runCount: schedule.runCount
    };
  }

  async _persistSchedules() {
    const schedules = Array.from(this.schedules.values()).map(s => this._serializeSchedule(s));
    const dir = path.dirname(this.persistencePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.persistencePath, JSON.stringify(schedules, null, 2));
    this.emit('schedules:persisted', { count: schedules.length });
  }

  _calculateNextRun(cronExpression) {
    try {
      const intervals = cronExpression.split(' ');
      if (intervals.length !== 5) return null;
      
      const now = new Date();
      let nextRun = new Date(now);
      nextRun.setSeconds(0);
      nextRun.setMilliseconds(0);
      
      const minute = parseInt(intervals[0]);
      const hour = parseInt(intervals[1]);
      const dayOfMonth = intervals[2] === '*' ? null : parseInt(intervals[2]);
      const month = intervals[3] === '*' ? null : parseInt(intervals[3]) - 1;
      const dayOfWeek = intervals[4] === '*' ? null : parseInt(intervals[4]);
      
      if (!isNaN(minute)) nextRun.setMinutes(minute);
      if (!isNaN(hour)) nextRun.setHours(hour);
      
      if (nextRun <= now) {
        nextRun.setDate(nextRun.getDate() + 1);
      }
      
      return nextRun;
    } catch {
      return null;
    }
  }

  _startSchedule(schedule) {
    if (this.cronJobs.has(schedule.id)) {
      this._stopSchedule(schedule.id);
    }

    if (!schedule.enabled) {
      return;
    }

    if (!cron.validate(schedule.cronExpression)) {
      this.emit('schedule:error', { 
        scheduleId: schedule.id, 
        error: 'Invalid cron expression' 
      });
      return;
    }

    const job = cron.schedule(schedule.cronExpression, async () => {
      await this._executeSchedule(schedule.id);
    }, {
      scheduled: true,
      timezone: 'UTC'
    });

    this.cronJobs.set(schedule.id, job);
    
    schedule.nextRun = this._calculateNextRun(schedule.cronExpression);
    this.emit('schedule:started', { scheduleId: schedule.id, nextRun: schedule.nextRun });
  }

  _stopSchedule(scheduleId) {
    const job = this.cronJobs.get(scheduleId);
    if (job) {
      job.stop();
      job.destroy();
      this.cronJobs.delete(scheduleId);
      this.emit('schedule:stopped', { scheduleId });
    }
  }

  async _startAllSchedules() {
    for (const schedule of this.schedules.values()) {
      if (schedule.enabled) {
        this._startSchedule(schedule);
      }
    }
  }

  async _executeSchedule(scheduleId) {
    const schedule = this.schedules.get(scheduleId);
    if (!schedule || !schedule.enabled || this.isShuttingDown) {
      return;
    }

    const acquired = await this.semaphore.acquire();
    if (!acquired) {
      this.emit('schedule:skipped', { 
        scheduleId, 
        reason: 'Max concurrent recordings reached' 
      });
      return;
    }

    try {
      schedule.lastRun = new Date();
      schedule.runCount++;
      schedule.nextRun = this._calculateNextRun(schedule.cronExpression);
      await this._persistSchedules();

      this.emit('schedule:triggered', { scheduleId, schedule });

      const recording = await this.recordingService.record({
        streamUrl: schedule.streamUrl,
        quality: schedule.quality,
        protocol: schedule.protocol,
        duration: schedule.duration,
        outputPath: schedule.outputPath,
        metadata: {
          ...schedule.metadata,
          scheduleId: schedule.id,
          scheduleName: schedule.name
        }
      });

      this.emit('schedule:recording-started', { scheduleId, recording });
      
    } catch (error) {
      this.emit('schedule:error', { scheduleId, error: error.message });
    } finally {
      this.semaphore.release();
    }
  }

  async addSchedule(scheduleData) {
    const schedule = {
      id: scheduleData.id || `sched_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      name: scheduleData.name,
      streamUrl: scheduleData.streamUrl,
      cronExpression: scheduleData.cronExpression,
      quality: scheduleData.quality || this.defaultQuality,
      protocol: scheduleData.protocol || StreamProtocol.HLS,
      duration: scheduleData.duration || 3600,
      outputPath: scheduleData.outputPath,
      enabled: scheduleData.enabled !== false,
      metadata: scheduleData.metadata || {},
      createdAt: new Date(),
      updatedAt: new Date(),
      lastRun: null,
      nextRun: null,
      runCount: 0
    };

    if (!cron.validate(schedule.cronExpression)) {
      throw new Error('Invalid cron expression');
    }

    this.schedules.set(schedule.id, schedule);
    this._startSchedule(schedule);
    await this._persistSchedules();

    this.emit('schedule:added', { schedule });
    return schedule;
  }

  async removeSchedule(id) {
    const schedule = this.schedules.get(id);
    if (!schedule) {
      throw new Error(`Schedule not found: ${id}`);
    }

    this._stopSchedule(id);
    this.schedules.delete(id);
    await this._persistSchedules();

    this.emit('schedule:removed', { scheduleId: id });
    return true;
  }

  async enableSchedule(id) {
    const schedule = this.schedules.get(id);
    if (!schedule) {
      throw new Error(`Schedule not found: ${id}`);
    }

    schedule.enabled = true;
    schedule.updatedAt = new Date();
    this._startSchedule(schedule);
    await this._persistSchedules();

    this.emit('schedule:enabled', { schedule });
    return schedule;
  }

  async disableSchedule(id) {
    const schedule = this.schedules.get(id);
    if (!schedule) {
      throw new Error(`Schedule not found: ${id}`);
    }

    schedule.enabled = false;
    schedule.updatedAt = new Date();
    this._stopSchedule(id);
    await this._persistSchedules();

    this.emit('schedule:disabled', { schedule });
    return schedule;
  }

  getSchedule(id) {
    return this.schedules.get(id) || null;
  }

  getSchedules() {
    return Array.from(this.schedules.values());
  }

  getActiveRecordings() {
    return this.recordingService.getActiveRecordings();
  }

  getSemaphoreStatus() {
    return {
      maxConcurrent: this.maxConcurrentRecordings,
      available: this.semaphore.getAvailable(),
      queueLength: this.semaphore.getQueueLength()
    };
  }

  async shutdown() {
    this.isShuttingDown = true;
    this.emit('scheduler:shutting-down');

    for (const [id, job] of this.cronJobs) {
      job.stop();
      job.destroy();
    }
    this.cronJobs.clear();

    await this.recordingService.shutdown();
    await this._persistSchedules();

    this.emit('scheduler:shutdown');
  }
}

module.exports = { StreamSchedulerService, Semaphore };