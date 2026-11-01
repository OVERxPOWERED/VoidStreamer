const axios = require('axios');
const cheerio = require('cheerio');
const { StructuredLogger } = require('./structured-logging-service');
const { TelemetryService } = require('./telemetry-service');
const { ConfigService } = require('./config-service');

class CircuitBreaker {
  constructor(options = {}) {
    this.failureThreshold = options.failureThreshold || 5;
    this.resetTimeout = options.resetTimeout || 30000;
    this.failureCount = 0;
    this.lastFailureTime = null;
    this.state = 'CLOSED';
  }

  async execute(operation) {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailureTime >= this.resetTimeout) {
        this.state = 'HALF_OPEN';
      } else {
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
    this.failureCount = 0;
    this.state = 'CLOSED';
  }

  onFailure() {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    if (this.failureCount >= this.failureThreshold) {
      this.state = 'OPEN';
    }
  }

  getState() {
    return this.state;
  }

  reset() {
    this.failureCount = 0;
    this.lastFailureTime = null;
    this.state = 'CLOSED';
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
      resetTimeout: options.circuitBreakerResetTimeout || 30000
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

  async sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  calculateBackoff(attempt) {
    const delay = this.baseDelay * Math.pow(2, attempt);
    const jitter = Math.random() * 0.3 * delay;
    return Math.floor(delay + jitter);
  }

  classifyError(error) {
    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      return new StreamScraperError('Request timeout', ERROR_CODES.TIMEOUT_ERROR, { originalError: error.message });
    }
    if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED' || error.code === 'ENETUNREACH') {
      return new StreamScraperError('Network error', ERROR_CODES.NETWORK_ERROR, { originalError: error.message });
    }
    if (error.response) {
      return new StreamScraperError(
        `HTTP ${error.response.status}`,
        ERROR_CODES.HTTP_ERROR,
        { status: error.response.status, statusText: error.response.statusText }
      );
    }
    if (error.message?.includes('Circuit breaker')) {
      return new StreamScraperError('Circuit breaker open', ERROR_CODES.CIRCUIT_OPEN);
    }
    return new StreamScraperError('Unknown error', ERROR_CODES.NETWORK_ERROR, { originalError: error.message });
  }

  async fetchWithRetry(url, options = {}, correlationId = null) {
    const startTime = Date.now();
    let lastError;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const result = await this.circuitBreaker.execute(async () => {
          const headers = {
            ...options.headers,
            'User-Agent': this.getRandomUserAgent()
          };

          if (correlationId) {
            headers['X-Correlation-ID'] = correlationId;
          }

          const response = await this.axiosInstance.get(url, {
            ...options,
            headers
          });

          if (response.status >= 400) {
            throw new StreamScraperError(
              `HTTP ${response.status}`,
              ERROR_CODES.HTTP_ERROR,
              { status: response.status, url }
            );
          }

          return response;
        });

        const duration = Date.now() - startTime;
        this.telemetry.recordHttpRequest({
          url,
          method: 'GET',
          statusCode: result.status,
          duration,
          success: true
        });

        this.logger.info('Stream fetch successful', {
          correlationId,
          url,
          statusCode: result.status,
          duration,
          attempt: attempt + 1
        });

        return result;
      } catch (error) {
        lastError = this.classifyError(error);
        
        this.logger.warn('Stream fetch attempt failed', {
          correlationId,
          url,
          attempt: attempt + 1,
          maxRetries: this.maxRetries,
          error: lastError.message,
          errorCode: lastError.code
        });

        if (attempt < this.maxRetries && this.isRetryableError(lastError)) {
          const delay = this.calculateBackoff(attempt);
          await this.sleep(delay);
          continue;
        }
        break;
      }
    }

    const duration = Date.now() - startTime;
    this.telemetry.recordHttpRequest({
      url,
      method: 'GET',
      statusCode: lastError?.details?.status || 0,
      duration,
      success: false,
      error: lastError?.code
    });

    throw new StreamScraperError(
      `Max retries (${this.maxRetries}) exceeded for ${url}`,
      ERROR_CODES.MAX_RETRIES_EXCEEDED,
      { lastError: lastError?.message, url }
    );
  }

  isRetryableError(error) {
    return [
      ERROR_CODES.NETWORK_ERROR,
      ERROR_CODES.TIMEOUT_ERROR
    ].includes(error.code) || 
    (error.code === ERROR_CODES.HTTP_ERROR && error.details.status >= 500);
  }

  parseHtml(html, url) {
    try {
      const $ = cheerio.load(html);
      
      const metadata = {
        url,
        title: null,
        description: null,
        streams: [],
        thumbnails: [],
        metadata: {}
      };

      metadata.title = $('title').first().text().trim() || 
                       $('meta[property="og:title"]').attr('content') ||
                       $('meta[name="twitter:title"]').attr('content') ||
                       $('h1').first().text().trim();

      metadata.description = $('meta[property="og:description"]').attr('content') ||
                             $('meta[name="description"]').attr('content') ||
                             $('meta[name="twitter:description"]').attr('content') ||
                             $('p').first().text().trim().substring(0, 500);

      $('meta[property^="og:"]').each((i, el) => {
        const property = $(el).attr('property');
        const content = $(el).attr('content');
        if (property && content) {
          metadata.metadata[property] = content;
        }
      });

      $('meta[name^="twitter:"]').each((i, el) => {
        const name = $(el).attr('name');
        const content = $(el).attr('content');
        if (name && content) {
          metadata.metadata[name] = content;
        }
      });

      $('link[rel="preload"][as="video"], link[rel="preload"][as="audio"]').each((i, el) => {
        const href = $(el).attr('href');
        const type = $(el).attr('type');
        if (href) {
          metadata.streams.push({ url: href, type, source: 'preload' });
        }
      });

      $('video source, audio source').each((i, el) => {
        const src = $(el).attr('src');
        const type = $(el).attr('type');
        if (src) {
          metadata.streams.push({ url: src, type, source: 'media-element' });
        }
      });

      $('video, audio').each((i, el) => {
        const src = $(el).attr('src');
        const type = $(el).attr('type');
        if (src) {
          metadata.streams.push({ url: src, type, source: 'media-tag' });
        }
      });

      $('a[href$=".m3u8"], a[href$=".mpd"], a[href*=".m3u8"], a[href*=".mpd"]').each((i, el) => {
        const href = $(el).attr('href');
        if (href) {
          metadata.streams.push({ url: href, type: 'application/vnd.apple.mpegurl', source: 'anchor' });
        }
      });

      $('iframe[src*="player"], iframe[src*="embed"], iframe[src*="stream"]').each((i, el) => {
        const src = $(el).attr('src');
        if (src) {
          metadata.streams.push({ url: src, type: 'iframe', source: 'iframe' });
        }
      });

      $('img').each((i, el) => {
        const src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-lazy');
        if (src && (src.includes('.jpg') || src.includes('.jpeg') || src.includes('.png') || src.includes('.webp'))) {
          metadata.thumbnails.push(src);
        }
      });

      metadata.thumbnails = [...new Set(metadata.thumbnails)].slice(0, 10);
      metadata.streams = this.deduplicateStreams(metadata.streams);

      return metadata;
    } catch (error) {
      throw new StreamScraperError(
        'Failed to parse HTML',
        ERROR_CODES.PARSING_ERROR,
        { originalError: error.message, url }
      );
    }
  }

  deduplicateStreams(streams) {
    const seen = new Set();
    return streams.filter(stream => {
      const key = `${stream.url}|${stream.type}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  async scrape(url, options = {}) {
    const correlationId = options.correlationId || this.logger.generateCorrelationId();
    const startTime = Date.now();

    this.logger.info('Starting stream scrape', { correlationId, url, options });

    try {
      const response = await this.fetchWithRetry(url, options, correlationId);
      
      const contentType = response.headers['content-type'] || '';
      let metadata;

      if (contentType.includes('text/html')) {
        metadata = this.parseHtml(response.data, url);
      } else if (contentType.includes('application/json')) {
        metadata = { url, data: response.data, contentType };
      } else {
        metadata = { url, contentType, rawLength: response.data?.length || 0 };
      }

      const duration = Date.now() - startTime;
      
      this.telemetry.recordScrapeOperation({
        url,
        duration,
        success: true,
        streamsFound: metadata.streams?.length || 0
      });

      this.logger.info('Stream scrape completed', {
        correlationId,
        url,
        duration,
        streamsFound: metadata.streams?.length || 0,
        hasTitle: !!metadata.title
      });

      return {
        success: true,
        correlationId,
        metadata,
        response: {
          status: response.status,
          headers: response.headers
        }
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      const scraperError = error instanceof StreamScraperError ? error : this.classifyError(error);

      this.telemetry.recordScrapeOperation({
        url,
        duration,
        success: false,
        error: scraperError.code
      });

      this.logger.error('Stream scrape failed', {
        correlationId,
        url,
        duration,
        error: scraperError.message,
        errorCode: scraperError.code,
        details: scraperError.details
      });

      return {
        success: false,
        correlationId,
        error: {
          code: scraperError.code,
          message: scraperError.message,
          details: scraperError.details
        }
      };
    }
  }

  async scrapeMultiple(urls, options = {}) {
    const concurrency = options.concurrency || 3;
    const results = [];
    const queue = [...urls];
    const running = new Set();

    const processQueue = async () => {
      while (queue.length > 0 || running.size > 0) {
        while (running.size < concurrency && queue.length > 0) {
          const url = queue.shift();
          const promise = this.scrape(url, { ...options, correlationId: options.correlationId })
            .then(result => {
              results.push(result);
              running.delete(promise);
            })
            .catch(error => {
              results.push({
                success: false,
                url,
                error: { message: error.message, code: error.code }
              });
              running.delete(promise);
            });
          running.add(promise);
        }
        if (running.size > 0) {
          await Promise.race(running);
        }
      }
    };

    await processQueue();
    return results;
  }

  getCircuitBreakerState() {
    return this.circuitBreaker.getState();
  }

  resetCircuitBreaker() {
    this.circuitBreaker.reset();
  }

  updateConfig(config) {
    if (config.maxRetries !== undefined) this.maxRetries = config.maxRetries;
    if (config.baseDelay !== undefined) this.baseDelay = config.baseDelay;
    if (config.connectTimeout !== undefined) this.connectTimeout = config.connectTimeout;
    if (config.responseTimeout !== undefined) this.responseTimeout = config.responseTimeout;
    if