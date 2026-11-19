const axios = require('axios');
const cheerio = require('cheerio');
const { StructuredLogger } = require('./structured-logging-service');
const { TelemetryService } = require('./telemetry-service');
const { ConfigService } = require('./config-service');
const { RetryPolicy, defaultRetryPolicy } = require('../utils/retry-policy');

class CircuitBreaker {
  constructor(options = {}) {
    this.failureThreshold = options.failureThreshold || 5;
    this.resetTimeout = options.resetTimeout || 30000;
    this.successThreshold = options.successThreshold || 2;
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = null;
    this.state = 'CLOSED';
    this.totalRequests = 0;
    this.rejectedRequests = 0;
  }

  async execute(operation) {
    this.totalRequests++;

    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailureTime >= this.resetTimeout) {
        this.state = 'HALF_OPEN';
        this.successCount = 0;
      } else {
        this.rejectedRequests++;
        throw new Error('Circuit breaker is OPEN');
      }
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  onSuccess() {
    if (this.state === 'HALF_OPEN') {
      this.successCount++;
      if (this.successCount >= this.successThreshold) {
        this.state = 'CLOSED';
        this.failureCount = 0;
        this.successCount = 0;
      }
    } else if (this.state === 'CLOSED') {
      this.failureCount = 0;
    }
  }

  onFailure() {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    
    if (this.state === 'HALF_OPEN') {
      this.state = 'OPEN';
      this.successCount = 0;
    } else if (this.state === 'CLOSED' && this.failureCount >= this.failureThreshold) {
      this.state = 'OPEN';
    }
  }

  getState() {
    return this.state;
  }

  getMetrics() {
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailureTime: this.lastFailureTime,
      totalRequests: this.totalRequests,
      rejectedRequests: this.rejectedRequests
    };
  }

  reset() {
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = null;
    this.state = 'CLOSED';
    this.totalRequests = 0;
    this.rejectedRequests = 0;
  }
}

class StreamScraperError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'StreamScraperError';
    this.code = code;
    this.details = details;
  }
}

const ERROR_CODES = {
  NETWORK_ERROR: 'NETWORK_ERROR',
  TIMEOUT_ERROR: 'TIMEOUT_ERROR',
  HTTP_ERROR: 'HTTP_ERROR',
  PARSING_ERROR: 'PARSING_ERROR',
  CIRCUIT_OPEN: 'CIRCUIT_OPEN',
  MAX_RETRIES_EXCEEDED: 'MAX_RETRIES_EXCEEDED',
  INVALID_RESPONSE: 'INVALID_RESPONSE'
};

class StreamScraperService {
  constructor(options = {}) {
    this.config = options.config || new ConfigService();
    this.logger = options.logger || new StructuredLogger();
    this.telemetry = options.telemetry || new TelemetryService();
    
    this.maxRetries = options.maxRetries || 3;
    this.baseDelay = options.baseDelay || 1000;
    this.connectTimeout = options.connectTimeout || 5000;
    this.responseTimeout = options.responseTimeout || 15000;
    
    this.circuitBreaker = new CircuitBreaker({
      failureThreshold: options.circuitBreakerThreshold || 5,
      resetTimeout: options.circuitBreakerResetTimeout || 30000,
      successThreshold: options.circuitBreakerSuccessThreshold || 2
    });

    this.retryPolicy = options.retryPolicy || defaultRetryPolicy;

    this.userAgents = this.config.get('scraper.userAgents') || [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15'
    ];

    this.axiosInstance = axios.create({
      timeout: this.responseTimeout,
      maxRedirects: 5,
      validateStatus: (status) => status >= 200 && status < 400,
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Cache-Control': 'max-age=0'
      }
    });

    this.axiosInstance.interceptors.request.use((config) => {
      config.headers['User-Agent'] = this.getRandomUserAgent();
      return config;
    });

    this.axiosInstance.interceptors.response.use(
      (response) => response,
      (error) => {
        if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
          throw new StreamScraperError('Request timeout', ERROR_CODES.TIMEOUT_ERROR, { originalError: error.message });
        }
        if (!error.response) {
          throw new StreamScraperError('Network error', ERROR_CODES.NETWORK_ERROR, { originalError: error.message });
        }
        throw new StreamScraperError(`HTTP ${error.response.status}`, ERROR_CODES.HTTP_ERROR, { 
          status: error.response.status,
          statusText: error.response.statusText 
        });
      }
    );
  }

  getRandomUserAgent() {
    return this.userAgents[Math.floor(Math.random() * this.userAgents.length)];
  }

  async fetchStreamMetadata(url) {
    const startTime = Date.now();
    
    try {
      const result = await this.circuitBreaker.execute(async () => {
        return await this.retryPolicy.execute(async () => {
          const response = await this.axiosInstance.get(url, {
            timeout: this.connectTimeout
          });
          return response;
        });
      });

      const metadata = this.parseStreamPage(result.data, url);
      
      this.telemetry.recordMetric('stream_scraper.duration', Date.now() - startTime, { url });
      this.telemetry.incrementCounter('stream_scraper.success', { url });
      
      return metadata;
    } catch (error) {
      this.telemetry.recordMetric('stream_scraper.duration', Date.now() - startTime, { url });
      this.telemetry.incrementCounter('stream_scraper.error', { url, error: error.code || 'UNKNOWN' });
      
      if (error.message === 'Circuit breaker is OPEN') {
        throw new StreamScraperError('Circuit breaker is open', ERROR_CODES.CIRCUIT_OPEN, { url });
      }
      
      if (error.name === 'RetryPolicyError' || error.code === 'MAX_RETRIES_EXCEEDED') {
        throw new StreamScraperError('Max retries exceeded', ERROR_CODES.MAX_RETRIES_EXCEEDED, { url, originalError: error.message });
      }
      
      throw error;
    }
  }

  parseStreamPage(html, url) {
    if (!html || typeof html !== 'string') {
      throw new StreamScraperError('Invalid response: empty HTML', ERROR_CODES.INVALID_RESPONSE, { url });
    }

    const $ = cheerio.load(html);
    
    const metadata = {
      url,
      title: null,
      description: null,
      thumbnail: null,
      streamUrl: null,
      isLive: false,
      viewerCount: null,
      category: null,
      tags: [],
      scrapedAt: new Date().toISOString()
    };

    try {
      metadata.title = this.extractTitle($);
      metadata.description = this.extractDescription($);
      metadata.thumbnail = this.extractThumbnail($);
      metadata.streamUrl = this.extractStreamUrl($, url);
      metadata.isLive = this.extractIsLive($);
      metadata.viewerCount = this.extractViewerCount($);
      metadata.category = this.extractCategory($);
      metadata.tags = this.extractTags($);
    } catch (parseError) {
      this.logger.warn('Partial parsing failure', { url, error: parseError.message });
      throw new StreamScraperError('Failed to parse stream page', ERROR_CODES.PARSING_ERROR, { 
        url, 
        originalError: parseError.message 
      });
    }

    return metadata;
  }

  extractTitle($) {
    const selectors = [
      'meta[property="og:title"]',
      'meta[name="twitter:title"]',
      'h1.title',
      'h1.stream-title',
      '.stream-title',
      'title'
    ];

    for (const selector of selectors) {
      const element = $(selector).first();
      if (element.length) {
        const content = element.attr('content') || element.text();
        if (content && content.trim()) {
          return content.trim();
        }
      }
    }
    return null;
  }

  extractDescription($) {
    const selectors = [
      'meta[property="og:description"]',
      'meta[name="twitter:description"]',
      'meta[name="description"]',
      '.stream-description',
      '.description'
    ];

    for (const selector of selectors) {
      const element = $(selector).first();
      if (element.length) {
        const content = element.attr('content') || element.text();
        if (content && content.trim()) {
          return content.trim();
        }
      }
    }
    return null;
  }

  extractThumbnail($) {
    const selectors = [
      'meta[property="og:image"]',
      'meta[name="twitter:image"]',
      '.stream-thumbnail img',
      '.thumbnail img',
      'img.stream-preview'
    ];

    for (const selector of selectors) {
      const element = $(selector).first();
      if (element.length) {
        const content = element.attr('content') || element.attr('src') || element.attr('data-src');
        if (content && content.trim()) {
          return content.trim();
        }
      }
    }
    return null;
  }

  extractStreamUrl($, baseUrl) {
    const selectors = [
      'meta[property="og:video"]',
      'meta[property="og:video:url"]',
      'meta[name="twitter:player:stream"]',
      'source[type*="video"]',
      'video source',
      '.stream-url',
      '[data-stream-url]'
    ];

    for (const selector of selectors) {
      const element = $(selector).first();
      if (element.length) {
        const content = element.attr('content') || element.attr('src') || element.attr('data-stream-url');
        if (content && content.trim()) {
          return new URL(content.trim(), baseUrl).href;
        }
      }
    }
    return null;
  }

  extractIsLive($) {
    const liveIndicators = [
      'meta[property="og:video:is_live"]',
      '[data-is-live="true"]',
      '.live-indicator',
      '.is-live',
      '[aria-live="polite"]'
    ];

    for (const selector of liveIndicators) {
      const element = $(selector).first();
      if (element.length) {
        const value = element.attr('content') || element.attr('data-is-live') || element.text();
        if (value && (value === 'true' || value === '1' || value.toLowerCase().includes('live'))) {
          return true;
        }
      }
    }

    const pageText = $('body').text().toLowerCase();
    return pageText.includes('live now') || pageText.includes('currently live') || pageText.includes('streaming live');
  }

  extractViewerCount($) {
    const selectors = [
      '[data-viewer-count]',
      '.viewer-count',
      '.viewers',
      '[aria-label*="viewer"]',
      '[aria-label*="watching"]'
    ];

    for (const selector of selectors) {
      const element = $(selector).first();
      if (element.length) {
        const text = element.attr('data-viewer-count') || element.attr('aria-label') || element.text();
        const match = text.match(/[\d,]+/);
        if (match) {
          return parseInt(match[0].replace(/,/g, ''), 10);
        }
      }
    }
    return null;
  }

  extractCategory($) {
    const selectors = [
      'meta[property="og:video:tag"]',
      'meta[name="twitter:label1"]',
      '.stream-category',
      '.category',
      '[data-category]'
    ];

    for (const selector of selectors) {
      const element = $(selector).first();
      if (element.length) {
        const content = element.attr('content') || element.attr('data-category') || element.text();
        if (content && content.trim()) {
          return content.trim();
        }
      }
    }
    return null;
  }

  extractTags($) {
    const tags = [];
    const selectors = [
      'meta[property="og:video:tag"]',
      'meta[name="keywords"]',
      '.tags a',
      '.tag',
      '[data-tag]'
    ];

    for (const selector of selectors) {
      const elements = $(selector);
      elements.each((_, el) => {
        const content = $(el).attr('content') || $(el).attr('data-tag') || $(el).text();
        if (content && content.trim()) {
          const splitTags = content.split(',').map(t => t.trim()).filter(t => t);
          tags.push(...splitTags);
        }
      });
    }

    return [...new Set(tags)];
  }

  async scrapeStream(url) {
    return this.fetchStreamMetadata(url);
  }

  getCircuitBreakerMetrics() {
    return this.circuitBreaker.getMetrics();
  }

  getRetryMetrics() {
    return this.retryPolicy.getMetrics();
  }

  getCombinedMetrics() {
    return {
      circuitBreaker: this.getCircuitBreakerMetrics(),
      retryPolicy: this.getRetryMetrics(),
      timestamp: new Date().toISOString()
    };
  }

  resetCircuitBreaker() {
    this.circuitBreaker.reset();
    this.logger.info('Circuit breaker manually reset');
  }

  resetRetryPolicy() {
    this.retryPolicy.reset();
    this.logger.info('Retry policy manually reset');
  }

  async healthCheck() {
    const cbState = this.circuitBreaker.getState();
    const retryMetrics = this.retryPolicy.getMetrics();
    
    return {
      healthy: cbState !== 'OPEN',
      circuitBreakerState: cbState,
      retryPolicyHealthy: retryMetrics.failureRate < 0.5,
      metrics: this.getCombinedMetrics()
    };
  }
}

module.exports = {
  StreamScraperService,
  StreamScraperError,
  ERROR_CODES,
  CircuitBreaker
};