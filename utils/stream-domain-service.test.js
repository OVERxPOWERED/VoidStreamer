```javascript
const StreamDomainService = require('./streamService.js');
const QueryCacheService = require('./query-cacheService.js');

jest.mock('axios');
jest.mock('cheerio');

const axios = require('axios');
const cheerio = require('cheerio');

describe('StreamDomainService', () => {
  let service;
  let mockCheerioLoad;
  let mockCheerioInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    
    service = new StreamDomainService();
    
    mockCheerioInstance = {
      find: jest.fn().mockReturnThis(),
      each: jest.fn().mockReturnThis(),
      text: jest.fn().mockReturnThis(),
      attr: jest.fn().mockReturnThis(),
      first: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      length: 0,
    };
    
    mockCheerioLoad = jest.fn(() => mockCheerioInstance);
    cheerio.load.mockImplementation(mockCheerioLoad);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('searchStreams', () => {
    const mockSearchResults = [
      { title: 'Movie 1', quality: '1080p', source: 'source1', url: 'http://source1.com/movie1' },
      { title: 'Movie 2', quality: '720p', source: 'source2', url: 'http://source2.com/movie2' },
      { title: 'Movie 3', quality: '4K', source: 'source1', url: 'http://source1.com/movie3' },
    ];

    beforeEach(() => {
      axios.get.mockResolvedValue({ data: '<html></html>' });
      mockCheerioInstance.find.mockReturnValue(mockCheerioInstance);
      mockCheerioInstance.each.mockImplementation((callback) => {
        mockSearchResults.forEach((result, index) => {
          const mockElement = {
            find: jest.fn().mockReturnValue({
              text: jest.fn(() => result.title),
              attr: jest.fn(() => result.url),
            }),
            attr: jest.fn((key) => key === 'data-quality' ? result.quality : (key === 'data-source' ? result.source : null)),
          };
          callback(index, mockElement);
        });
        return mockCheerioInstance;
      });
      mockCheerioInstance.length = mockSearchResults.length;
    });

    test('returns empty array for empty query', async () => {
      const results = await service.searchStreams('');
      expect(results).toEqual([]);
      expect(axios.get).not.toHaveBeenCalled();
    });

    test('returns empty array for whitespace-only query', async () => {
      const results = await service.searchStreams('   ');
      expect(results).toEqual([]);
      expect(axios.get).not.toHaveBeenCalled();
    });

    test('filters results by quality when specified', async () => {
      const results = await service.searchStreams('movie', { quality: '1080p' });
      expect(results).toHaveLength(1);
      expect(results[0].quality).toBe('1080p');
    });

    test('filters results by source when specified', async () => {
      const results = await service.searchStreams('movie', { source: 'source2' });
      expect(results).toHaveLength(1);
      expect(results[0].source).toBe('source2');
    });

    test('applies pagination correctly', async () => {
      const results = await service.searchStreams('movie', { page: 1, limit: 2 });
      expect(results).toHaveLength(2);
      expect(results[0].title).toBe('Movie 1');
      expect(results[1].title).toBe('Movie 2');
    });

    test('returns cached results on cache hit', async () => {
      await service.searchStreams('movie');
      jest.clearAllMocks();
      
      const results = await service.searchStreams('movie');
      expect(axios.get).not.toHaveBeenCalled();
      expect(results).toHaveLength(3);
    });

    test('fetches fresh results on cache miss', async () => {
      await service.searchStreams('movie');
      jest.clearAllMocks();
      
      axios.get.mockResolvedValue({ data: '<html></html>' });
      mockCheerioInstance.each.mockImplementation((callback) => {
        [{ title: 'New Movie', quality: '1080p', source: 'source1', url: 'http://new.com' }].forEach((result, index) => {
          const mockElement = {
            find: jest.fn().mockReturnValue({
              text: jest.fn(() => result.title),
              attr: jest.fn(() => result.url),
            }),
            attr: jest.fn((key) => key === 'data-quality' ? result.quality : (key === 'data-source' ? result.source : null)),
          };
          callback(index, mockElement);
        });
        return mockCheerioInstance;
      });
      mockCheerioInstance.length = 1;

      const results = await service.searchStreams('different query');
      expect(axios.get).toHaveBeenCalled();
      expect(results[0].title).toBe('New Movie');
    });

    test('handles network errors gracefully', async () => {
      axios.get.mockRejectedValue(new Error('Network error'));
      const results = await service.searchStreams('movie');
      expect(results).toEqual([]);
    });

    test('handles parsing errors gracefully', async () => {
      mockCheerioInstance.each.mockImplementation(() => {
        throw new Error('Parsing error');
      });
      const results = await service.searchStreams('movie');
      expect(results).toEqual([]);
    });
  });

  describe('getStreamUrl', () => {
    const mockStreamData = {
      url: 'http://source1.com/stream',
      quality: '1080p',
      source: 'source1',
      referer: 'http://source1.com',
    };

    beforeEach(() => {
      service.sources = new Map([
        ['source1', { 
          baseUrl: 'http://source1.com', 
          active: true,
          getStreamUrl: jest.fn().mockResolvedValue(mockStreamData),
        }],
        ['source2', { 
          baseUrl: 'http://source2.com', 
          active: true,
          getStreamUrl: jest.fn().mockResolvedValue({ ...mockStreamData, source: 'source2' }),
        }],
      ]);
    });

    test('returns stream URL for valid source and quality', async () => {
      const result = await service.getStreamUrl('movie123', 'source1', '1080p');
      expect(result).toEqual(mockStreamData);
      expect(service.sources.get('source1').getStreamUrl).toHaveBeenCalledWith('movie123', '1080p');
    });

    test('throws error for invalid source', async () => {
      await expect(service.getStreamUrl('movie123', 'invalid-source', '1080p'))
        .rejects.toThrow('Source not found: invalid-source');
    });

    test('throws error for inactive source', async () => {
      service.sources.get('source1').active = false;
      await expect(service.getStreamUrl('movie123', 'source1', '1080p'))
        .rejects.toThrow('Source is inactive: source1');
    });

    test('falls back to default quality when requested quality unavailable', async () => {
      service.sources.get('source1').getStreamUrl.mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ ...mockStreamData, quality: '720p' });
      
      const result = await service.getStreamUrl('movie123', 'source1', '4K');
      expect(result.quality).toBe('720p