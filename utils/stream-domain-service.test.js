```javascript
jest.mock('axios');
jest.mock('cheerio');
jest.mock('../../../utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const axios = require('axios');
const cheerio = require('cheerio');
const StreamDomainService = require('../stream-domain-service');
const QueryCacheService = require('../query-cache-service');
const InputSanitizationService = require('../input-sanitization-service');

describe('StreamDomainService', () => {
  let service;
  let mockCacheService;
  let mockSanitizationService;
  let mockCheerioLoad;

  const mockStreamHtml = `
    <html>
      <body>
        <div class="stream-item" data-id="1" data-title="Test Stream 1" data-quality="1080p" data-source="source1" data-url="https://source1.com/stream1.m3u8">
          <span class="title">Test Stream 1</span>
          <span class="quality">1080p</span>
        </div>
        <div class="stream-item" data-id="2" data-title="Test Stream 2" data-quality="720p" data-source="source2" data-url="https://source2.com/stream2.m3u8">
          <span class="title">Test Stream 2</span>
          <span class="quality">720p</span>
        </div>
        <div class="stream-item" data-id="3" data-title="Test Stream 3" data-quality="480p" data-source="source1" data-url="https://source1.com/stream3.m3u8">
          <span class="title">Test Stream 3</span>
          <span class="quality">480p</span>
        </div>
      </body>
    </html>
  `;

  const mockEmptyHtml = '<html><body><div class="no-results">No streams found</div></body></html>';

  beforeEach(() => {
    jest.clearAllMocks();

    mockCacheService = {
      get: jest.fn(),
      set: jest.fn(),
      has: jest.fn(),
      delete: jest.fn(),
      clear: jest.fn(),
    };

    mockSanitizationService = {
      sanitizeSearchQuery: jest.fn((query) => query.trim()),
      sanitizeUrl: jest.fn((url) => url),
      validateQuality: jest.fn((quality) => ['1080p', '720p', '480p', 'auto'].includes(quality)),
      sanitizeSourceName: jest.fn((source) => source.toLowerCase().trim()),
    };

    mockCheerioLoad = jest.fn(() => ({
      find: jest.fn().mockReturnThis(),
      each: jest.fn(),
      attr: jest.fn(),
      text: jest.fn(),
      html: jest.fn(),
    }));

    cheerio.load.mockImplementation(mockCheerioLoad);

    service = new StreamDomainService({
      cacheService: mockCacheService,
      sanitizationService: mockSanitizationService,
      baseUrl: 'https://streams.example.com',
      requestTimeout: 5000,
    });
  });

  describe('searchStreams', () => {
    const mockSearchResults = [
      {
        id: '1',
        title: 'Test Stream 1',
        quality: '1080p',
        source: 'source1',
        url: 'https://source1.com/stream1.m3u8',
        metadata: {
          language: 'en',
          bitrate: 5000,
          codec: 'h264',
        },
      },
      {
        id: '2',
        title: 'Test Stream 2',
        quality: '720p',
        source: 'source2',
        url: 'https://source2.com/stream2.m3u8',
        metadata: {
          language: 'en',
          bitrate: 3000,
          codec: 'h264',
        },
      },
      {
        id: '3',
        title: 'Test Stream 3',
        quality: '480p',
        source: 'source1',
        url: 'https://source1.com/stream3.m3u8',
        metadata: {
          language: 'es',
          bitrate: 1500,
          codec: 'h264',
        },
      },
    ];

    beforeEach(() => {
      const mock$ = cheerio.load(mockStreamHtml);
      const streamItems = [
        {
          attr: (name) => {
            const attrs = {
              'data-id': '1',
              'data-title': 'Test Stream 1',
              'data-quality': '1080p',
              'data-source': 'source1',
              'data-url': 'https://source1.com/stream1.m3u8',
            };
            return attrs[name];
          },
          find: () => ({
            text: () => 'Test Stream 1',
          }),
        },
        {
          attr: (name) => {
            const attrs = {
              'data-id': '2',
              'data-title': 'Test Stream 2',
              'data-quality': '720p',
              'data-source': 'source2',
              'data-url': 'https://source2.com/stream2.m3u8',
            };
            return attrs[name];
          },
          find: () => ({
            text: () => 'Test Stream 2',
          }),
        },
        {
          attr: (name) => {
            const attrs = {
              'data-id': '3',
              'data-title': 'Test Stream 3',
              'data-quality': '480p',
              'data-source': 'source1',
              'data-url': 'https://source1.com/stream3.m3u8',
            };
            return attrs[name];
          },
          find: () => ({
            text: () => 'Test Stream 3',
          }),
        },
      ];

      mock$.prototype.find.mockReturnValue({
        each: (callback) => {
          streamItems.forEach((item, index) => callback(index, item));
        },
      });

      cheerio.load.mockReturnValue(mock$);
    });

    it('should return mapped StreamMetadata array on successful search', async () => {
      axios.get.mockResolvedValue({ data: mockStreamHtml, status: 200 });
      mockCacheService.has.mockReturnValue(false);
      mockSanitizationService.sanitizeSearchQuery.mockReturnValue('test query');

      const results = await service.searchStreams('test query');

      expect(results).toHaveLength(3);
      expect(results[0]).toMatchObject({
        id: '1',
        title: 'Test Stream 1',
        quality: '1080p',
        source: 'source1',
        url: 'https://source1.com/stream1.m3u8',
      });
      expect(results[1]).toMatchObject({
        id: '2',
        title: 'Test Stream 2',
        quality: '720p',
        source: 'source2',
      });
      expect(results[2]).toMatchObject({
        id: '3',
        title: 'Test Stream 3',
        quality: '480p',
        source: 'source1',
      });
      expect(axios.get).toHaveBeenCalledWith(
        'https://streams.example.com/search',
        expect.objectContaining({
          params: { q: 'test query' },
          timeout: 5000,
        })
      );
    });