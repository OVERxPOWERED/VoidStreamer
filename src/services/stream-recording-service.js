const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const ffmpegStatic = require('ffmpeg-static');
const StructuredLoggingService = require('./structured-logging-service');

class StreamRecordingService extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.logger = options.logger || new StructuredLoggingService();
    this.maxConcurrentRecordings = options.maxConcurrentRecordings || 5;
    this.defaultMaxDuration = options.defaultMaxDuration || 3600000; // 1 hour default
    this.storagePath = options.storagePath || path.join(process.cwd(), 'recordings');
    this.cleanupInterval = options.cleanupInterval || 300000; // 5 minutes
    
    this.recordings = new Map();
    this.cleanupTimer = null;
    
    this._ensureStorageDirectory();
    this._startCleanupJob();
  }

  _ensureStorageDirectory() {
    if (!fs.existsSync(this.storagePath)) {
      fs.mkdirSync(this.storagePath, { recursive: true });
    }
  }

  _startCleanupJob() {
    this.cleanupTimer = setInterval(() => {
      this._cleanupExpiredRecordings();
    }, this.cleanupInterval);
    
    this.cleanupTimer.unref();
  }

  _cleanupExpiredRecordings() {
    const now = Date.now();
    
    for (const [recordingId, recording] of this.recordings.entries()) {
      if (recording.status === 'completed' || recording.status === 'failed') {
        const age = now - recording.endedAt;
        const maxAge = recording.options.retentionPeriod || 86400000; // 24 hours default
        
        if (age > maxAge) {
          this._deleteRecordingFiles(recordingId);
          this.recordings.delete(recordingId);
          this.logger.info('Recording cleaned up', { recordingId, age });
        }
      } else if (recording.status === 'recording') {
        const duration = now - recording.startedAt;
        const maxDuration = recording.options.maxDuration || this.defaultMaxDuration;
        
        if (duration > maxDuration) {
          this.logger.warn('Recording exceeded max duration, stopping', { 
            recordingId, 
            duration, 
            maxDuration 
          });
          this.stopRecording(recordingId).catch(err => {
            this.logger.error('Failed to stop expired recording', { recordingId, error: err.message });
          });
        }
      }
    }
  }

  _getActiveRecordingCount() {
    let count = 0;
    for (const recording of this.recordings.values()) {
      if (recording.status === 'recording') {
        count++;
      }
    }
    return count;
  }

  async startRecording(streamUrl, options = {}) {
    const activeCount = this._getActiveRecordingCount();
    if (activeCount >= this.maxConcurrentRecordings) {
      throw new Error(`Maximum concurrent recordings (${this.maxConcurrentRecordings}) reached`);
    }

    const recordingId = `rec_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const recordingDir = path.join(this.storagePath, recordingId);
    
    fs.mkdirSync(recordingDir, { recursive: true });

    const recordingOptions = {
      maxDuration: options.maxDuration || this.defaultMaxDuration,
      segmentDuration: options.segmentDuration || 10,
      retentionPeriod: options.retentionPeriod || 86400000,
      format: options.format || 'hls',
      videoCodec: options.videoCodec || 'copy',
      audioCodec: options.audioCodec || 'copy',
      ...options
    };

    const recording = {
      id: recordingId,
      streamUrl,
      options: recordingOptions,
      status: 'starting',
      startedAt: Date.now(),
      endedAt: null,
      directory: recordingDir,
      manifestPath: path.join(recordingDir, 'playlist.m3u8'),
      segmentPattern: path.join(recordingDir, 'segment_%05d.ts'),
      ffmpegProcess: null,
      segmentCount: 0,
      totalDuration: 0,
      error: null
    };

    this.recordings.set(recordingId, recording);

    try {
      await this._startFFmpegRecording(recording);
      
      recording.status = 'recording';
      this.emit('recording:started', { recordingId, streamUrl, options: recordingOptions });
      this.logger.info('Recording started', { recordingId, streamUrl, options: recordingOptions });
      
      return recordingId;
    } catch (error) {
      recording.status = 'failed';
      recording.error = error.message;
      recording.endedAt = Date.now();
      this.emit('recording:error', { recordingId, error: error.message });
      this.logger.error('Failed to start recording', { recordingId, error: error.message });
      throw error;
    }
  }

  _startFFmpegRecording(recording) {
    return new Promise((resolve, reject) => {
      const args = [
        '-i', recording.streamUrl,
        '-c:v', recording.options.videoCodec,
        '-c:a', recording.options.audioCodec,
        '-f', 'hls',
        '-hls_time', recording.options.segmentDuration.toString(),
        '-hls_list_size', '0',
        '-hls_segment_filename', recording.segmentPattern,
        '-hls_playlist_type', 'event',
        '-y',
        recording.manifestPath
      ];

      const ffmpegProcess = spawn(ffmpegStatic, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false
      });

      recording.ffmpegProcess = ffmpegProcess;

      let stderrBuffer = '';
      
      ffmpegProcess.stderr.on('data', (data) => {
        stderrBuffer += data.toString();
        
        const lines = stderrBuffer.split('\n');
        stderrBuffer = lines.pop() || '';
        
        for (const line of lines) {
          if (line.includes('segment') && line.includes('.ts')) {
            recording.segmentCount++;
          }
        }
      });

      ffmpegProcess.on('error', (error) => {
        recording.status = 'failed';
        recording.error = error.message;
        recording.endedAt = Date.now();
        reject(error);
      });

      ffmpegProcess.on('close', (code) => {
        recording.endedAt = Date.now();
        recording.totalDuration = recording.endedAt - recording.startedAt;
        
        if (code === 0) {
          recording.status = 'completed';
          this.emit('recording:stopped', { 
            recordingId: recording.id, 
            duration: recording.totalDuration,
            segmentCount: recording.segmentCount
          });
          this.logger.info('Recording completed', { 
            recordingId: recording.id, 
            duration: recording.totalDuration,
            segmentCount: recording.segmentCount
          });
        } else {
          recording.status = 'failed';
          recording.error = `FFmpeg exited with code ${code}: ${stderrBuffer}`;
          this.emit('recording:error', { 
            recordingId: recording.id, 
            error: recording.error 
          });
          this.logger.error('Recording failed', { 
            recordingId: recording.id, 
            code, 
            stderr: stderrBuffer 
          });
        }
      });

      setTimeout(() => {
        if (recording.status === 'starting') {
          recording.status = 'recording';
          resolve();
        }
      }, 2000);
    });
  }

  async stopRecording(recordingId) {
    const recording = this.recordings.get(recordingId);
    
    if (!recording) {
      throw new Error(`Recording not found: ${recordingId}`);
    }

    if (recording.status !== 'recording' && recording.status !== 'starting') {
      throw new Error(`Recording is not active: ${recordingId} (status: ${recording.status})`);
    }

    return new Promise((resolve, reject) => {
      if (recording.ffmpegProcess) {
        recording.ffmpegProcess.on('close', () => {
          recording.endedAt = Date.now();
          recording.totalDuration = recording.endedAt - recording.startedAt;
          recording.status = 'completed';
          
          this.emit('recording:stopped', { 
            recordingId, 
            duration: recording.totalDuration,
            segmentCount: recording.segmentCount
          });
          this.logger.info('Recording stopped', { 
            recordingId, 
            duration: recording.totalDuration,
            segmentCount: recording.segmentCount
          });
          resolve();
        });

        recording.ffmpegProcess.kill('SIGTERM');
        
        setTimeout(() => {
          if (recording.ffmpegProcess && !recording.ffmpegProcess.killed) {
            recording.ffmpegProcess.kill('SIGKILL');
          }
        }, 5000);
      } else {
        recording.status = 'failed';
        recording.error = 'No FFmpeg process found';
        recording.endedAt = Date.now();
        reject(new Error('No FFmpeg process found'));
      }
    });
  }

  getRecordingStatus(recordingId) {
    const recording = this.recordings.get(recordingId);
    
    if (!recording) {
      return null;
    }

    const status = {
      id: recording.id,
      streamUrl: recording.streamUrl,
      status: recording.status,
      startedAt: recording.startedAt,
      endedAt: recording.endedAt,
      duration: recording.endedAt ? recording.endedAt - recording.startedAt : Date.now() - recording.startedAt,
      segmentCount: recording.segmentCount,
      totalDuration: recording.totalDuration,
      options: recording.options,
      error: recording.error,
      manifestUrl: recording.status === 'completed' || recording.status === 'recording' 
        ? `/recordings/${recordingId}/playlist.m3u8` 
        : null
    };

    return status;
  }

  listRecordings(filter = {}) {
    const recordings = [];
    
    for (const recording of this.recordings.values()) {
      if (filter.status && recording.status !== filter.status) {
        continue;
      }
      
      if (filter.since && recording.startedAt < filter.since) {
        continue;
      }
      
      recordings.push(this.getRecordingStatus(recording.id));
    }
    
    return recordings.sort((a, b) => b.startedAt - a.startedAt);
  }

  _deleteRecordingFiles(recordingId) {
    const recording = this.recordings.get(recordingId);
    
    if (!recording) {
      return;
    }

    try {
      if (fs.existsSync(recording.directory)) {
        const files = fs.readdirSync(recording.directory);
        for (const file of files) {
          fs.unlinkSync(path.join(recording.directory, file));
        }
        fs.rmdirSync(recording.directory);
      }
    } catch (error) {
      this.logger.error('Failed to delete recording files', { recordingId, error: error.message });
    }
  }

  async getRecordingManifest(recordingId) {
    const recording = this.recordings.get(recordingId);
    
    if (!recording) {
      throw new Error(`Recording not found: ${recordingId}`);
    }

    if (!fs.existsSync(recording.manifestPath)) {
      throw new Error(`Manifest not found for recording: ${recordingId}`);
    }

    return fs.readFileSync(recording.manifestPath, 'utf8');
  }

  async getRecordingSegment(recordingId, segmentName) {
    const recording = this.recordings.get(recordingId);
    
    if (!recording) {
      throw new Error(`Recording not found: ${recordingId}`);
    }

    const segmentPath = path.join(recording.directory, segmentName);
    
    if (!fs.existsSync(segmentPath)) {
      throw new Error(`Segment not found: ${segmentName}`);
    }

    return fs.createReadStream(segmentPath);
  }

  shutdown() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    const stopPromises = [];
    for (const [recordingId, recording] of this.recordings.entries()) {
      if (recording.status === 'recording' || recording.status === 'starting') {
        stopPromises.push(this.stopRecording(recordingId).catch(err => {
          this.logger.error('Error stopping recording during shutdown', { recordingId, error: err.message });
        }));
      }
    }

    return Promise.all(stopPromises);
  }
}

module.exports = StreamRecordingService;