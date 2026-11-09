const axios = require('axios');
const cheerio = require('cheerio');
const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs').promises;

// Mock dependencies before importing services
jest.mock('axios');
jest.mock('cheerio');
jest.mock('child_process', () => ({
  spawn: jest.fn(),
}));

const { spawn } = require('child_process');
const StreamQualityService = require('../../src/services/stream-quality-service');
const StreamRecordingService = require('../../src/services/stream-recording-service');
const Orchestrator = require('../../src/orchestrator');
const CacheService = require('../../src/services/cache-service');
const MetricsService = require('../../src/services/metrics-service');
const CircuitBreaker = require('../../src/utils/circuit-breaker');

describe('Stream Quality & Recording Integration Tests', () => {
  let orchestrator;
  let cacheService;
  let metricsService;
  let mockAxiosGet;
  let mockCheerioLoad;
  let mockSpawn;

  beforeAll(() => {
    mockAxiosGet = axios.get;
    mockCheerioLoad = cheerio.load;
    mockSpawn = spawn;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Reset singleton instances
    CacheService.instance = null;
    MetricsService.instance = null;
    CircuitBreaker.instances.clear();

    cacheService = CacheService.getInstance();
    metricsService = MetricsService.getInstance();
    
    orchestrator = new Orchestrator({
      maxConcurrentRecordings: 2,
      qualityPreferences: ['1080p', '720p', '480p'],
      cacheTtl: 300000,
      circuitBreakerThreshold: 3,
      circuitBreakerTimeout: 30000,
    });

    // Default mock implementations
    mockAxiosGet.mockResolvedValue({ data: '', status: 200 });
    mockCheerioLoad.mockReturnValue(() => ({ find: () => ({ each: () => {} }) }));
    mockSpawn.mockReturnValue({
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      on: jest.fn(),
      kill: jest.fn(),
      pid: 12345,
    });
  });

  afterEach(async () => {
    await orchestrator.shutdown();
  });

  describe('StreamQualityService.parseQualitiesFromHtml()', () => {
    let qualityService;

    beforeEach(() => {
      qualityService = new StreamQualityService();
    });

    test('parses HLS master playlist with multiple qualities', async () => {
      const masterPlaylist = `
#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.4d0028,mp4a.40.2"
stream_1080p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,CODECS="avc1.4d001f,mp4a.40.2"
stream_720p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=854x480,CODECS="avc1.4d001e,mp4a.40.2"
stream_480p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d001e,mp4a.40.2"
stream_360p.m3u8
`;

      mockAxiosGet.mockResolvedValueOnce({ data: masterPlaylist, status: 200 });

      const qualities = await qualityService.parseQualitiesFromHtml('https://example.com/stream.m3u8');

      expect(qualities).toHaveLength(4);
      expect(qualities[0]).toMatchObject({
        resolution: '1080p',
        bandwidth: 5000000,
        width: 1920,
        height: 1080,
        codecs: 'avc1.4d0028,mp4a.40.2',
        url: expect.stringContaining('stream_1080p.m3u8'),
      });
      expect(qualities[1].resolution).toBe('720p');
      expect(qualities[2].resolution).toBe('480p');
      expect(qualities[3].resolution).toBe('360p');
    });

    test('parses HTML page with embedded stream data', async () => {
      const htmlContent = `
<!DOCTYPE html>
<html>
<head><title>Stream Page</title></head>
<body>
  <script>
    window.streamData = {
      "qualities": [
        {"label": "1080p", "bitrate": 5000, "url": "https://cdn.example.com/1080p.m3u8"},
        {"label": "720p", "bitrate": 3000, "url": "https://cdn.example.com/720p.m3u8"},
        {"label": "480p", "bitrate": 1500, "url": "https://cdn.example.com/480p.m3u8"}
      ]
    };
  </script>
  <div class="player" data-stream-url="https://cdn.example.com/master.m3u8"></div>
</body>
</html>
`;

      const mock$ = {
        find: jest.fn().mockReturnThis(),
        each: jest.fn((callback) => {
          const scripts = [
            { html: () => 'window.streamData = {"qualities":[{"label":"1080p","bitrate":5000,"url":"https://cdn.example.com/1080p.m3u8"},{"label":"720p","bitrate":3000,"url":"https://cdn.example.com/720p.m3u8"},{"label":"480p","bitrate":1500,"url":"https://cdn.example.com/480p.m3u8"}]};' },
          ];
          scripts.forEach((script, i) => callback(i, script));
        }),
        attr: jest.fn((name) => name === 'data-stream-url' ? 'https://cdn.example.com/master.m3u8' : null),
      };

      mockCheerioLoad.mockReturnValue(() => mock$);
      mockAxiosGet.mockResolvedValueOnce({ data: htmlContent, status: 200 });

      const qualities = await qualityService.parseQualitiesFromHtml('https://example.com/watch/123');

      expect(qualities).toHaveLength(3);
      expect(qualities[0]).toMatchObject({
        resolution: '1080p',
        bandwidth: 5000000,
        url: 'https://cdn.example.com/1080p.m3u8',
      });
    });

    test('parses DASH manifest with multiple representations', async () => {
      const dashManifest = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" mediaPresentationDuration="PT3600S">
  <Period>
    <AdaptationSet mimeType="video/mp4">
      <Representation id="1080p" bandwidth="5000000" width="1920" height="1080" codecs="avc1.640028">
        <BaseURL>video_1080p.mp4</BaseURL>
      </Representation>
      <Representation id="720p" bandwidth="3000000" width="1280" height="720" codecs="avc1.64001f">
        <BaseURL>video_720p.mp4</BaseURL>
      </Representation>
      <Representation id="480p" bandwidth="1500000" width="854" height="480" codecs="avc1.64001e">
        <BaseURL>video_480p.mp4</BaseURL>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

      mockAxiosGet.mockResolvedValueOnce({ data: dashManifest, status: 200 });

      const qualities = await qualityService.parseQualitiesFromHtml('https://example.com/manifest.mpd');

      expect(qualities).toHaveLength(3);
      expect(qualities.map(q => q.resolution)).toEqual(['1080p', '720p', '480p']);
      expect(qualities[0].url).toContain('video_1080p.mp4');
    });

    test('handles malformed HTML gracefully', async () => {
      mockAxiosGet.mockResolvedValueOnce({ data: 'not valid html', status: 200 });
      mockCheerioLoad.mockReturnValue(() => ({
        find: () => ({ each: () => {} }),
      }));

      const qualities = await qualityService.parseQualitiesFromHtml('https://example.com/broken');

      expect(qualities).toEqual([]);
    });

    test('handles network errors with retry logic', async () => {
      mockAxiosGet
        .mockRejectedValueOnce(new Error('Network error'))
        .mockRejectedValueOnce(new Error('Timeout'))
        .mockResolvedValueOnce({ data: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=3000000\nstream.m3u8', status: 200 });

      const qualities = await qualityService.parseQualitiesFromHtml('https://example.com/stream.m3u8', { retries: 3 });

      expect(qualities).toHaveLength(1);
      expect(mockAxiosGet).toHaveBeenCalledTimes(3);
    });

    test('caches parsed qualities', async () => {
      const masterPlaylist = `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=3000000\nstream.m3u8`;
      mockAxiosGet.mockResolvedValue({ data: masterPlaylist, status: 200 });

      await qualityService.parseQualitiesFromHtml('https://example.com/stream.m3u8');
      await qualityService.parseQualitiesFromHtml('https://example.com/stream.m3u8');

      expect(mockAxiosGet).toHaveBeenCalledTimes(1);
      const cached = await cacheService.get('quality:https://example.com/stream.m3u8');
      expect(cached).toBeDefined();
    });
  });

  describe('StreamQualityService.selectOptimalQuality()', () => {
    let qualityService;

    beforeEach(() => {
      qualityService = new StreamQualityService();
    });

    const mockQualities = [
      { resolution: '1080p', bandwidth: 5000000, width: 1920, height: 1080, url: 'http://cdn/1080p.m3u8' },
      { resolution: '720p', bandwidth: 3000000, width: 1280, height: 720, url: 'http://cdn/720p.m3u8' },
      { resolution: '480p', bandwidth: 1500000, width: 854, height: 480, url: 'http://cdn/480p.m3u8' },
      { resolution: '360p', bandwidth: 800000, width: 640, height: 360, url: 'http://cdn/360p.m3u8' },
    ];

    test('selects highest quality by default', () => {
      const selected = qualityService.selectOptimalQuality(mockQualities);
      expect(selected.resolution).toBe('1080p');
    });

    test('selects based on preference order', () => {
      const selected = qualityService.selectOptimalQuality(mockQualities, { preference: ['720p', '1080p', '480p'] });
      expect(selected.resolution).toBe('720p');
    });

    test('selects based on maximum bandwidth constraint', () => {
      const selected = qualityService.selectOptimalQuality(mockQualities, { maxBandwidth: 2000000 });
      expect(selected.resolution).toBe('480p');
    });

    test('selects based on minimum resolution constraint', () => {
      const selected = qualityService.selectOptimalQuality(mockQualities, { minResolution: '720p' });
      expect(selected.resolution).toBe('720p');
    });

    test('selects exact resolution match when available', () => {
      const selected = qualityService.selectOptimalQuality(mockQualities, { exactResolution: '480p' });
      expect(selected.resolution).toBe('480p');
    });

    test('falls back to closest lower quality when exact not available', () => {
      const selected = qualityService.selectOptimalQuality(mockQualities, { exactResolution: '540p' });
      expect(selected.resolution).toBe('480p');
    });

    test('handles adaptive bitrate preferences', () => {
      const selected = qualityService.selectOptimalQuality(mockQualities, {
        adaptive: true,
        targetBuffer: 30,
        maxSwitchFrequency: 3,
      });
      expect(selected.resolution).toBe('1080p');
      expect(selected.adaptiveConfig).toEqual({
        targetBuffer: 30,
        maxSwitchFrequency: 3,
      });
    });

    test('returns null for empty qualities array', () => {
      const selected = qualityService.selectOptimalQuality([]);
      expect(selected).toBeNull();
    });

    test('throws on invalid preference format', () => {
      expect(() => {
        qualityService.selectOptimalQuality(mockQualities, { preference: 'invalid' });
      }).toThrow('Preference must be an array');
    });

    test('emits quality selection metric', () => {
      const metricsSpy = jest.spyOn(metricsService, 'recordQualitySelection');
      
      qualityService.selectOptimalQuality(mockQualities, { preference: ['720p'] });
      
      expect(metricsSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          selectedResolution: '720p',
          availableQualities: 4,
          selectionReason: 'preference_match',
        })
      );
    });
  });

  describe('StreamRecordingService Lifecycle', () => {
    let recordingService;
    let mockFfmpegProcess;

    beforeEach(() => {
      recordingService = new StreamRecordingService({
        ffmpegPath: 'ffmpeg',
        outputDir: '/tmp/recordings',
        maxConcurrent: 2,
      });

      mockFfmpegProcess = {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        on: jest.fn((event, cb) => {
          if (event === 'close') setTimeout(() => cb(0), 10);
          if (event === 'error') setTimeout(() => cb(new Error('ffmpeg error')), 10);
          return mockFfmpegProcess;
        }),
        kill: jest.fn((signal) => {
          if (signal === 'SIGTERM') setTimeout(() => mockFfmpegProcess.emit('close', 0), 10);
        }),
        pid: 12345,
        stdin: { write: jest.fn(), end: jest.fn() },
      };

      mockSpawn.mockReturnValue(mockFfmpegProcess);
    });

    test('starts recording successfully', async () => {
      const recording = await recordingService.startRecording({
        streamUrl: 'https://example.com/stream.m3u8',
        quality: '720p',
        outputPath: '/tmp/recordings/test_720p.mp4',
        metadata: { title: 'Test Stream', streamer: 'testuser' },
      });

      expect(recording).toMatchObject({
        id: expect.any(String),
        status: 'recording',
        streamUrl: 'https://example.com/stream.m3u8',
        quality: '720p',
        outputPath: '/tmp/recordings/test_720p.mp4',
        pid: