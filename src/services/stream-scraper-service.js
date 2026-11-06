const axios = require('axios');
const cheerio = require('cheerio');
const { StructuredLogger } = require('./structured-logging-service');
const { TelemetryService } = require('./telemetry-service');
const { ConfigService } = require('./config-service');

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

    this.userAgents = this.config.get('scraper.userAgents') || [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15'
    ];

    this.axiosInstance = this.createAxiosInstance();
  }

  createAxiosInstance() {
    return axios.create({
      timeout: this.responseTimeout,
      connectTimeout: this.connectTimeout,
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
      },
      validateStatus: (status) => status < 500,
      maxRedirects: 5,
      decompress: true
    });
  }

  getRandomUserAgent() {
    const index = Math.floor(Math.random() * this.userAgents.length);
    return this.userAgents[index];
  }

  async scrape(url, options = {}) {
    const startTime = Date.now();
    const requestId = options.requestId || `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    this.logger.info('Starting scrape request', { url, requestId });

    try {
      const result = await this.circuitBreaker.execute(async () => {
        return await this.scrapeWithRetry(url, options, requestId);
      });

      const duration = Date.now() - startTime;
      this.telemetry.recordScrapeSuccess(url, duration);
      this.logger.info('Scrape completed successfully', { url, requestId, duration });

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      this.telemetry.recordScrapeFailure(url, duration, error.code || 'UNKNOWN');
      this.logger.error('Scrape failed', { url, requestId, duration, error: error.message, code: error.code });
      throw error;
    }
  }

  async scrapeWithRetry(url, options, requestId) {
    let lastError;
    
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await this.makeRequest(url, options, requestId, attempt);
        return this.parseResponse(response, url, options);
      } catch (error) {
        lastError = error;
        
        if (error.code === ERROR_CODES.CIRCUIT_OPEN) {
          throw error;
        }

        if (attempt < this.maxRetries) {
          const delay = this.calculateBackoff(attempt);
          this.logger.warn('Retrying scrape', { url, requestId, attempt, delay, error: error.message });
          await this.sleep(delay);
        }
      }
    }

    throw new StreamScraperError(
      `Max retries (${this.maxRetries}) exceeded for ${url}`,
      ERROR_CODES.MAX_RETRIES_EXCEEDED,
      { url, attempts: this.maxRetries, lastError: lastError?.message }
    );
  }

  async makeRequest(url, options, requestId, attempt) {
    const headers = {
      'User-Agent': options.userAgent || this.getRandomUserAgent(),
      ...options.headers
    };

    if (options.referer) {
      headers['Referer'] = options.referer;
    }

    try {
      const response = await this.axiosInstance.get(url, {
        headers,
        timeout: this.responseTimeout,
        signal: options.signal
      });

      if (response.status >= 400) {
        throw new StreamScraperError(
          `HTTP ${response.status} for ${url}`,
          ERROR_CODES.HTTP_ERROR,
          { url, status: response.status, attempt }
        );
      }

      if (!response.data || typeof response.data !== 'string') {
        throw new StreamScraperError(
          'Invalid response: empty or non-string body',
          ERROR_CODES.INVALID_RESPONSE,
          { url, attempt }
        );
      }

      return response;
    } catch (error) {
      if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
        throw new StreamScraperError(
          `Request timeout for ${url}`,
          ERROR_CODES.TIMEOUT_ERROR,
          { url, attempt, originalError: error.message }
        );
      }
      
      if (error.isAxiosError) {
        throw new StreamScraperError(
          `Network error for ${url}: ${error.message}`,
          ERROR_CODES.NETWORK_ERROR,
          { url, attempt, originalError: error.message }
        );
      }
      
      throw error;
    }
  }

  parseResponse(response, url, options) {
    try {
      const $ = cheerio.load(response.data);
      
      const result = {
        url,
        statusCode: response.status,
        headers: response.headers,
        html: response.data,
        $,
        title: $('title').text().trim(),
        metaDescription: $('meta[name="description"]').attr('content') || '',
        metaKeywords: $('meta[name="keywords"]').attr('content') || '',
        canonicalUrl: $('link[rel="canonical"]').attr('href') || url,
        links: [],
        images: [],
        scripts: [],
        stylesheets: []
      };

      $('a[href]').each((i, el) => {
        const href = $(el).attr('href');
        if (href) {
          result.links.push({
            url: this.resolveUrl(url, href),
            text: $(el).text().trim(),
            title: $(el).attr('title') || ''
          });
        }
      });

      $('img[src]').each((i, el) => {
        const src = $(el).attr('src');
        if (src) {
          result.images.push({
            url: this.resolveUrl(url, src),
            alt: $(el).attr('alt') || '',
            title: $(el).attr('title') || ''
          });
        }
      });

      $('script[src]').each((i, el) => {
        const src = $(el).attr('src');
        if (src) {
          result.scripts.push(this.resolveUrl(url, src));
        }
      });

      $('link[rel="stylesheet"]').each((i, el) => {
        const href = $(el).attr('href');
        if (href) {
          result.stylesheets.push(this.resolveUrl(url, href));
        }
      });

      if (options.customSelectors) {
        result.custom = {};
        for (const [key, selector] of Object.entries(options.customSelectors)) {
          result.custom[key] = [];
          $(selector).each((i, el) => {
            result.custom[key].push({
              html: $.html(el),
              text: $(el).text().trim(),
              attributes: el.attribs
            });
          });
        }
      }

      return result;
    } catch (error) {
      throw new StreamScraperError(
        `Failed to parse response from ${url}: ${error.message}`,
        ERROR_CODES.PARSING_ERROR,
        { url, originalError: error.message }
      );
    }
  }

  resolveUrl(baseUrl, relativeUrl) {
    try {
      return new URL(relativeUrl, baseUrl).href;
    } catch {
      return relativeUrl;
    }
  }

  calculateBackoff(attempt) {
    const delay = this.baseDelay * Math.pow(2, attempt - 1);
    const jitter = Math.random() * 0.3 * delay;
    return Math.min(delay + jitter, 30000);
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getCircuitBreakerMetrics() {
    return this.circuitBreaker.getMetrics();
  }

  resetCircuitBreaker() {
    this.circuitBreaker.reset();
  }

  getCircuitBreakerState() {
    return this.circuitBreaker.getState();
  }
}

module.exports = {
  CircuitBreaker,
  StreamScraperService,
  StreamScraperError,
  ERROR_CODES
};