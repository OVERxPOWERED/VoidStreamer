```javascript
const nock = require('nock');
const cheerio = require('cheerio');
const axios = require('axios');
const { Stream, StreamSource, StreamQuality, PaginatedResult } = require('../../src/domain/stream-domain');
const { StreamService } = require('../../src/services/stream-service');
const { CacheService } = require('../../src/services/cache-service');
const { SourceResolver } = require('../../src/resolvers/source-resolver');

const BASE_URL = 'https://api.example.com';
const MOCK_HTML_SEARCH_RESULTS = `
<html>
  <body>
    <div class="results">
      <div class="stream-item" data-id="stream-1" data-title="Test Movie 1" data-year="2023" data-type="movie">
        <img src="https://example.com/poster1.jpg" alt="Poster 1">
      </div>
      <div class="stream-item" data-id="stream-2" data-title="Test Series 1" data-year="2022" data-type="series">
        <img src="https://example.com/poster2.jpg" alt="Poster 2">
      </div>
    </div>
    <div class="pagination">
      <span class="current-page">1</span>
      <span class="total-pages">5</span>
      <span class="total-items">50</span>
    </div>
  </body>
</html>
`;

const MOCK_HTML_STREAM_DETAIL = `
<html>
  <body>
    <div class="stream-detail" data-id="stream-1" data-title="Test Movie 1" data-year="2023" data-type="movie">
      <div class="sources">
        <div class="source" data-provider="provider-a" data-url="https://provider-a.com/embed/stream-1" data-quality="1080p" data-type="hls"></div>
        <div class="source" data-provider="provider-b" data-url="https://provider-b.com/embed/stream-1" data-quality="720p" data-type="hls"></div>
        <div class="source" data-provider="provider-c" data-url="https://provider-c.com/embed/stream-1" data-quality="4k" data-type="dash"></div>
      </div>
    </div>
  </body>
</html>
`;

const MOCK_HLS_MANIFEST = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080
https://cdn.example.com/stream-1/1080p/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720
https://cdn.example.com/stream-1/720p/playlist.m3u8
`;

const MOCK_DASH_MANIFEST = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" mediaPresentationDuration="PT3600S" minBufferTime="PT2S" profiles="urn:mpeg:dash:profile:isoff-live:2011">
  <Period>
    <AdaptationSet mimeType="video/mp4" segmentAlignment="true">
      <Representation id="1080p" bandwidth="5000000" width="1920" height="1080">
        <BaseURL>https://cdn.example.com/stream-1/1080p/</BaseURL>
        <SegmentTemplate initialization="init.mp4" media="seg-$Number$.m4s" startNumber="1" duration="10" timescale="1000"/>
      </Representation>
      <Representation id="720p" bandwidth="3000000" width="1280" height="720">
        <BaseURL>https://cdn.example.com/stream-1/720p/</BaseURL>
        <SegmentTemplate initialization="init.mp4" media="seg-$Number$.m4s" startNumber="1" duration="10" timescale="1000"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

describe('E2E Critical User Flows', () => {
  let streamService;
  let cacheService;
  let sourceResolver;
  let mockScope;

  beforeAll(() => {
    cacheService = new CacheService({ ttl: 300000, maxSize: 1000 });
    sourceResolver = new SourceResolver({ timeout: 10000, maxRedirects: 5 });
    streamService = new StreamService({ cacheService, sourceResolver, baseUrl: BASE_URL });
  });

  beforeEach(() => {
    mockScope = nock(BASE_URL);
    cacheService.clear();
    jest.clearAllMocks();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  describe('Flow 1: Search → Select → Resolve → Play', () => {
    it('should search streams and return paginated results with valid Stream objects', async () => {
      mockScope
        .get('/search')
        .query({ q: 'test movie', page: 1, limit: 20 })
        .reply(200, MOCK_HTML_SEARCH_RESULTS);

      const result = await streamService.searchStreams('test movie', { page: 1, limit: 20 });

      expect(result).toBeInstanceOf(PaginatedResult);
      expect(result.items).toHaveLength(2);
      expect(result.page).toBe(1);
      expect(result.totalPages).toBe(5);
      expect(result.totalItems).toBe(50);

      const stream1 = result.items[0];
      expect(stream1).toBeInstanceOf(Stream);
      expect(stream1.id).toBe('stream-1');
      expect(stream1.title).toBe('Test Movie 1');
      expect(stream1.year).toBe(2023);
      expect(stream1.type).toBe('movie');
      expect(stream1.posterUrl).toBe('https://example.com/poster1.jpg');
      expect(stream1.sources).toEqual([]);

      const stream2 = result.items[1];
      expect(stream2.id).toBe('stream-2');
      expect(stream2.title).toBe('Test Series 1');
      expect(stream2.year).toBe(2022);
      expect(stream2.type).toBe('series');
    });

    it('should get stream by ID and return Stream with resolved source URLs', async () => {
      mockScope
        .get('/stream/stream-1')
        .reply(200, MOCK_HTML_STREAM_DETAIL);

      const stream = await streamService.getStreamById('stream-1');

      expect(stream).toBeInstanceOf(Stream);
      expect(stream.id).toBe('stream-1');
      expect(stream.title).toBe('Test Movie 1');
      expect(stream.year).toBe(2023);
      expect(stream.type).toBe('movie');
      expect(stream.sources).toHaveLength(3);

      const source1 = stream.sources[0];
      expect(source1).toBeInstanceOf(StreamSource);
      expect(source1.provider).toBe('provider-a');
      expect(source1.url).toBe('https://provider-a.com/embed/stream-1');
      expect(source1.quality).toBeInstanceOf(StreamQuality);
      expect(source1.quality