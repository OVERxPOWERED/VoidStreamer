```javascript
const axios = require('axios');
const cheerio = require('cheerio');

jest.mock('axios');
jest.mock('cheerio');

const {
  StreamDomain,
  StreamMetadata,
  StreamQuality,
  StreamSource,
} = require('../../src/domain/stream-domain');

const {
  InputSanitizationService,
} = require('../../src/services/input-sanitization.service');

const {
  QueryCacheService,
} = require('../../src/services/query-cache.service');

const {
  TelemetryService,
} = require('../../src/services/telemetry.service');

const {
  HealthCheckService,
} = require('../../src/services/health-check.service');

describe('StreamDomain Models', () => {
  describe('StreamMetadata', () => {
    it('should create valid metadata with all required fields', () => {
      const metadata = new StreamMetadata({
        title: 'Test Stream',
        description: 'A test stream description',
        thumbnailUrl: 'https://example.com/thumb.jpg',
        duration: 3600,
        viewCount: 1000,
        publishedAt: new Date('2024-01-01'),
        tags: ['gaming', 'live'],
        category: 'Gaming',
        language: 'en',
        isLive: true,
      });

      expect(metadata.title).toBe('Test Stream');
      expect(metadata.description).toBe('A test stream description');
      expect(metadata.thumbnailUrl).toBe('https://example.com/thumb.jpg');
      expect(metadata.duration).toBe(3600);
      expect(metadata.viewCount).toBe(1000);
      expect(metadata.publishedAt).toEqual(new Date('2024-01-01'));
      expect(metadata.tags).toEqual(['gaming', 'live']);
      expect(metadata.category).toBe('Gaming');
      expect(metadata.language).toBe('en');
      expect(metadata.isLive).toBe(true);
    });

    it('should throw on missing required title', () => {
      expect(() => new StreamMetadata({})).toThrow('title is required');
    });

    it('should throw on invalid thumbnail URL', () => {
      expect(() => new StreamMetadata({
        title: 'Test',
        thumbnailUrl: 'not-a-url',
      })).toThrow('thumbnailUrl must be a valid URL');
    });

    it('should throw on negative duration', () => {
      expect(() => new StreamMetadata({
        title: 'Test',
        duration: -100,
      })).toThrow('duration must be non-negative');
    });

    it('should throw on negative viewCount', () => {
      expect(() => new StreamMetadata({
        title: 'Test',
        viewCount: -5,
      })).toThrow('viewCount must be non-negative');
    });

    it('should sanitize tags array', () => {
      const metadata = new StreamMetadata({
        title: 'Test',
        tags: ['  gaming  ', 'LIVE', '', '  ', 'streaming'],
      });

      expect(metadata.tags).toEqual(['gaming', 'live', 'streaming']);
    });

    it('should default optional fields', () => {
      const metadata = new StreamMetadata({ title: 'Test' });

      expect(metadata.description).toBe('');
      expect(metadata.thumbnailUrl).toBe('');
      expect(metadata.duration).toBe(0);
      expect(metadata.viewCount).toBe(0);
      expect(metadata.tags).toEqual([]);
      expect(metadata.category).toBe('General');
      expect(metadata.language).toBe('en');
      expect(metadata.isLive).toBe(false);
      expect(metadata.publishedAt).toBeInstanceOf(Date);
    });

    it('should serialize to JSON correctly', () => {
      const metadata = new StreamMetadata({
        title: 'Test Stream',
        description: 'Description',
        tags: ['tag1', 'tag2'],
      });

      const json = metadata.toJSON();

      expect(json).toEqual({
        title: 'Test Stream',
        description: 'Description',
        thumbnailUrl: '',
        duration: 0,
        viewCount: 0,
        publishedAt: expect.any(String),
        tags: ['tag1', 'tag2'],
        category: 'General',
        language: 'en',
        isLive: false,
      });
    });
  });

  describe('StreamQuality', () => {
    it('should create valid quality with all fields', () => {
      const quality = new StreamQuality({
        resolution: '1080p',
        bitrate: 5000,
        codec: 'h264',
        framerate: 60,
        audioBitrate: 128,
        audioCodec: 'aac',
      });

      expect(quality.resolution).toBe('1080p');
      expect(quality.bitrate).toBe(5000);
      expect(quality.codec).toBe('h264');
      expect(quality.framerate).toBe(60);
      expect(quality.audioBitrate).toBe(128);
      expect(quality.audioCodec).toBe('aac');
    });

    it('should validate resolution format', () => {
      expect(() => new StreamQuality({ resolution: 'invalid' })).toThrow('resolution must match format');
      expect(() => new StreamQuality({ resolution: '720p' })).not.toThrow();
      expect(() => new StreamQuality({ resolution: '4K' })).not.toThrow();
      expect(() => new StreamQuality({ resolution: '1080i' })).not.toThrow();
    });

    it('should throw on negative bitrate', () => {
      expect(() => new StreamQuality({ resolution: '720p', bitrate: -1 })).toThrow('bitrate must be positive');
    });

    it('should throw on invalid framerate', () => {
      expect(() => new StreamQuality({ resolution: '720p', framerate: 0 })).toThrow('framerate must be positive');
      expect(() => new StreamQuality({ resolution: '720p', framerate: 121 })).toThrow('framerate must be <= 120');
    });

    it('should calculate estimated bandwidth', () => {
      const quality = new StreamQuality({
        resolution: '1080p',
        bitrate: 5000,
        audioBitrate: 128,
      });

      expect(quality.estimatedBandwidthKbps).toBe(5128);
    });

    it('should compare qualities by bitrate', () => {
      const q1 = new StreamQuality({ resolution: '720p', bitrate: 3000 });
      const q2 = new StreamQuality({ resolution: '1080p', bitrate: 5000 });
      const q3 = new StreamQuality({ resolution: '480p', bitrate: 1500 });

      expect(StreamQuality.compare(q1, q2)).toBeLessThan(0);
      expect(StreamQuality.compare(q2, q1)).toBeGreaterThan(0);
      expect(StreamQuality.compare(q1, q1)).toBe(0);
      expect(StreamQuality.sort([q1, q2, q3]).map(q => q.resolution)).toEqual(['480p', '720p', '1080p']);
    });
  });

  describe('StreamSource', () => {
    it('should create valid source with required fields', () => {
      const source = new StreamSource({
        url: 'https://example.com/stream.m3u8',
        quality: new StreamQuality({ resolution: '720p', bitrate: 3