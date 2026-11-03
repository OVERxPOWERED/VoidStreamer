```javascript
const axios = require('axios');
const cheerio = require('cheerio');
const { InputSanitizationService } = require('../services/input-sanitization-service');
const { QueryCacheService } = require('../services/query-cache-service');
const {
  StreamSource,
  StreamSearchResult,
  StreamResolution,
  StreamQuality,
  SourceConfig,
  SearchOptions,
  StreamDomainError,
  SourceValidationError,
  StreamNotFoundError,
  ResolutionError
} = require('../domain/stream-domain');

class StreamDomainService {
  constructor(inputSanitizationService, queryCacheService) {
    if (!(inputSanitizationService instanceof InputSanitizationService)) {
      throw new TypeError('inputSanitizationService must be an instance of InputSanitizationService');
    }
    if (!(queryCacheService instanceof QueryCacheService)) {
      throw new TypeError('queryCacheService must be an instance of QueryCacheService');
    }

    this.inputSanitizationService = inputSanitizationService;
    this.queryCacheService = queryCacheService;
    this.sources = new Map();
    this.httpClient = axios.create({
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1'
      }
    });

    this._initializeDefaultSources();
  }

  _initializeDefaultSources() {
    const defaultSources = [
      new SourceConfig({
        id: '1337x',
        name: '1337x',
        baseUrl: 'https://1337x.to',
        searchPath: '/search/{query}/1/',
        enabled: true,
        priority: 1,
        selectors: {
          resultContainer: 'table.tbody tr',
          title: 'td.name a:nth-child(2)',
          magnetLink: 'td.name a[href^="magnet:"]',
          size: 'td.size',
          seeders: 'td.seeds',
          leechers: 'td.leechs',
          uploadDate: 'td.coll-date'
        },
        rateLimit: { requestsPerMinute: 30 },
        requiresJavaScript: false
      }),
      new SourceConfig({
        id: 'yts',
        name: 'YTS',
        baseUrl: 'https://yts.mx',
        searchPath: '/browse-movies/{query}/all/all/0/latest/0/all',
        enabled: true,
        priority: 2,
        selectors: {
          resultContainer: '.browse-movie-wrap',
          title: '.browse-movie-title',
          link: '.browse-movie-link',
          year: '.browse-movie-year',
          rating: '.rating'
        },
        rateLimit: { requestsPerMinute: 20 },
        requiresJavaScript: false
      }),
      new SourceConfig({
        id: 'nyaa',
        name: 'Nyaa.si',
        baseUrl: 'https://nyaa.si',
        searchPath: '/?f=0&c=0_0&q={query}',
        enabled: true,
        priority: 3,
        selectors: {
          resultContainer: 'tbody tr',
          title: 'td:nth-child(2) a:last-child',
          magnetLink: 'td:nth-child(3) a[href^="magnet:"]',
          size: 'td:nth-child(4)',
          seeders: 'td:nth-child(6)',
          leechers: 'td:nth-child(7)',
          uploadDate: 'td:nth-child(5)'
        },
        rateLimit: { requestsPerMinute: 30 },
        requiresJavaScript: false
      })
    ];

    for (const source of defaultSources) {
      this.sources.set(source.id, source);
    }
  }

  async searchStreams(query, options = {}) {
    const sanitizedQuery = this.inputSanitizationService.sanitizeSearchQuery(query);
    if (!sanitizedQuery || sanitizedQuery.trim().length === 0) {
      throw new StreamDomainError('Search query cannot be empty after sanitization');
    }

    const searchOptions = new SearchOptions(options);
    const cacheKey = this.queryCacheService.generateKey('search', {
      query: sanitizedQuery,
      ...searchOptions.toCacheKey()
    });

    const cached = this.queryCacheService.get(cacheKey);
    if (cached) {
      return cached.map(item => StreamSearchResult.fromJSON(item));
    }

    const enabledSources = Array.from(this.sources.values())
      .filter(source => source.enabled)
      .sort((a, b) => a.priority - b.priority);

    if (searchOptions.sourceIds && searchOptions.sourceIds.length > 0) {
      const filtered = enabledSources.filter(s => searchOptions.sourceIds.includes(s.id));
      if (filtered.length === 0) {
        throw new StreamDomainError('No valid sources specified in sourceIds');
      }
      enabledSources.splice(0, enabledSources.length, ...filtered);
    }

    const allResults = [];
    const errors = [];

    for (const source of enabledSources) {
      try {
        const results = await this._searchSource(source, sanitizedQuery, searchOptions);
        allResults.push(...results);
      } catch (error) {
        errors.push({ sourceId: source.id, error: error.message });
        if (searchOptions.failFast) {
          throw error;
        }
      }
    }

    allResults.sort((a, b) => {
      if (a.seeders !== b.seeders) return b.seeders - a.seeders;
      if (a.leechers !== b.leechers) return a.leechers - b.leechers;
      return new Date(b.uploadDate) - new Date(a.uploadDate);
    });

    const limitedResults = allResults.slice(0, searchOptions.limit || 50);

    const cacheData = limitedResults.map(r => r.toJSON());
    this.queryCacheService.set(cacheKey, cacheData, searchOptions.cacheTtl || 300000);

    return limitedResults;
  }

  async _searchSource(source, query, options) {
    const encodedQuery = encodeURIComponent(query);
    const searchUrl = `${source.baseUrl}${source.searchPath.replace('{query}', encodedQuery)}`;

    const response = await this.httpClient.get(searchUrl, {
      timeout: source.rateLimit?.requestTimeout || 10000
    });

    const $ = cheerio.load(response.data);
    const results = [];

    $(source.selectors.resultContainer).each((index, element) => {
      if (results.length >= (options.limit || 50)) return false;

      try {
        const $el = $(element);
        let title = '';
        let link = '';
        let magnetLink = '';
        let size = '';
        let seeders = 0;
        let leechers = 0;
        let uploadDate = new Date();

        if (source.id === '1337x') {
          title =