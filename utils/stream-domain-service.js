```javascript
const EventEmitter = require('events');
const axios = require('axios');
const cheerio = require('cheerio');
const { sanitizeSearchQuery, sanitizeUrl, sanitizeHtml } = require('./input-sanitization');
const { queryCache } = require('./query-cacheService');
const { validateConfig, validateEnvironment } = require('./environment-guardrails');
const {
  StreamConfig,
  StreamHealth,
  StreamQuality,
  Viewer,
  ChatMessage,
  Donation,
  Subscription,
  StreamEvent,
  StreamStatus,
  PlatformType,
  StreamSource,
  StreamSearchResult,
  StreamUrlResult,
  SourceValidationResult
} = require('../types/domain');

class StreamDomainService extends EventEmitter {
  constructor(config = {}) {
    super();
    
    validateEnvironment();
    const validatedConfig = validateConfig(config, {
      baseUrls: { type: 'object', required: true },
      timeout: { type: 'number', default: 10000 },
      userAgent: { type: 'string', default: 'Mozilla/5.0 (compatible; StreamBot/1.0)' },
      cacheTtl: { type: 'number', default: 300000 },
      maxConcurrentRequests: { type: 'number', default: 5 },
      retryAttempts: { type: 'number', default: 3 },
      retryDelay: { type: 'number', default: 1000 }
    });

    this.config = validatedConfig;
    this.baseUrls = validatedConfig.baseUrls;
    this.timeout = validatedConfig.timeout;
    this.userAgent = validatedConfig.userAgent;
    this.cacheTtl = validatedConfig.cacheTtl;
    this.maxConcurrentRequests = validatedConfig.maxConcurrentRequests;
    this.retryAttempts = validatedConfig.retryAttempts;
    this.retryDelay = validatedConfig.retryDelay;

    this.httpClient = axios.create({
      timeout: this.timeout,
      headers: {
        'User-Agent': this.userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate',
        'Connection': 'keep-alive'
      }
    });

    this.httpClient.interceptors.response.use(
      response => response,
      error => {
        this.emit('http:error', { url: error.config?.url, error: error.message });
        return Promise.reject(error);
      }
    );

    this.sourceValidators = new Map();
    this.selectorCache = new Map();
    this._initializeSourceValidators();
    this._setupEventHandlers();
  }

  _setupEventHandlers() {
    this.on('search:started', (query) => this._onSearchStarted(query));
    this.on('search:completed', (results) => this._onSearchCompleted(results));
    this.on('search:error', (error) => this._onSearchError(error));
    this.on('url:resolved', (result) => this._onUrlResolved(result));
    this.on('url:error', (error) => this._onUrlError(error));
    this.on('source:validated', (result) => this._onSourceValidated(result));
    this.on('source:health:check', (result) => this._onSourceHealthCheck(result));
  }

  _initializeSourceValidators() {
    this.sourceValidators.set('primary', this._validatePrimarySource.bind(this));
    this.sourceValidators.set('secondary', this._validateSecondarySource.bind(this));
    this.sourceValidators.set('tertiary', this._validateTertiarySource.bind(this));
    this.sourceValidators.set('custom', this._validateCustomSource.bind(this));
  }

  async searchStreams(query, options = {}) {
    const sanitizedQuery = sanitizeSearchQuery(query);
    const cacheKey = `search:${sanitizedQuery}:${JSON.stringify(options)}`;
    
    const cached = queryCache.get(cacheKey);
    if (cached) {
      this.emit('search:cache:hit', { query: sanitizedQuery });
      return cached;
    }

    this.emit('search:started', { query: sanitizedQuery, options });

    const sources = options.sources || Object.keys(this.baseUrls);
    const searchPromises = sources.map(source => this._searchSource(source, sanitizedQuery, options));
    
    const results = await this._executeWithConcurrencyControl(searchPromises, this.maxConcurrentRequests);
    const flattenedResults = results.flat().filter(Boolean);
    
    const deduplicated = this._deduplicateResults(flattenedResults);
    const sorted = this._sortResults(deduplicated, options.sortBy || 'relevance');
    
    const finalResults = sorted.slice(0, options.limit || 50);
    
    queryCache.set(cacheKey, finalResults, this.cacheTtl);
    
    this.emit('search:completed', { query: sanitizedQuery, count: finalResults.length });
    return finalResults;
  }

  async _searchSource(sourceName, query, options) {
    const baseUrl = this.baseUrls[sourceName];
    if (!baseUrl) {
      this.emit('source:not:found', { source: sourceName });
      return [];
    }

    const searchUrl = this._buildSearchUrl(baseUrl, query, options);
    
    try {
      const response = await this._retryRequest(() => this.httpClient.get(searchUrl));
      const $ = cheerio.load(response.data);
      
      const selectors = this._getSelectorsForSource(sourceName);
      const results = [];
      
      $(selectors.item).each((index, element) => {
        if (index >= (options.perSourceLimit || 20)) return false;
        
        const result = this._parseSearchResult($, element, selectors, sourceName);
        if (result) {
          results.push(result);
        }
      });
      
      return results;
    } catch (error) {
      this.emit('source:search:error', { source: sourceName, error: error.message });
      return [];
    }
  }

  _buildSearchUrl(baseUrl, query, options) {
    const url = new URL(baseUrl);
    url.searchParams.set('q', query);
    if (options.category) url.searchParams.set('category', options.category);
    if (options.language) url.searchParams.set('lang', options.language);
    if (options.page) url.searchParams.set('page', options.page);
    return sanitizeUrl(url.toString());
  }

  _getSelectorsForSource(sourceName) {
    if (this.selectorCache.has(sourceName)) {
      return this.selectorCache.get(sourceName);
    }

    const selectors = {
      item: '.stream-item, .video-item, .result-item, [data-stream-id]',
      title: '.title, .stream-title, h3, h4',
      url: 'a[href]',
      thumbnail: 'img[src], [data-src]',
      viewerCount: '.viewers, .view-count, [data-viewers]',
      platform: '.platform, .source-badge',
      isLive: '.live-badge, .is-live, [data-live="true"]',
      quality: '.quality, .resolution',
      category: '.category, .game-name',
      streamer: '.streamer, .channel-name, .author'
    };

    const sourceSpecificSelectors = this._getSourceSpecificSelectors(sourceName);
    const merged = { ...selectors, ...source