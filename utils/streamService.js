```javascript
/**
 * @typedef {import('../types/domain.d.ts').Stream} Stream
 * @typedef {import('../types/domain.d.ts').PaginatedResponse} PaginatedResponse
 * @typedef {import('../utils/validation').ValidateStreamFn} ValidateStreamFn
 */

const axios = require('axios');
const cheerio = require('cheerio');
const QueryCacheService = require('./query-cacheService.js');

/**
 * Custom error class for StreamService operations
 */
class StreamServiceError extends Error {
  /**
   * @param {string} message
   * @param {number} [statusCode]
   * @param {string} [code]
   * @param {Error} [cause]
   */
  constructor(message, statusCode = 500, code = 'STREAM_SERVICE_ERROR', cause = null) {
    super(message);
    this.name = 'StreamServiceError';
    this.statusCode = statusCode;
    this.code = code;
    this.cause = cause;
    Error.captureStackTrace(this, this.constructor);
  }

  /**
   * Create error from axios error
   * @param {Error} error
   * @returns {StreamServiceError}
   */
  static fromAxiosError(error) {
    if (error.response) {
      return new StreamServiceError(
        `Request failed with status ${error.response.status}: ${error.response.statusText}`,
        error.response.status,
        'HTTP_ERROR',
        error
      );
    }
    if (error.request) {
      return new StreamServiceError(
        'No response received from server',
        503,
        'NETWORK_ERROR',
        error
      );
    }
    return new StreamServiceError(
      error.message || 'Unknown error occurred',
      500,
      'UNKNOWN_ERROR',
      error
    );
  }
}

/**
 * Core domain service for stream discovery and management
 */
class StreamService {
  /**
   * @param {Object} options
   * @param {import('axios').AxiosInstance} [options.axiosInstance]
   * @param {string} options.baseUrl
   * @param {ValidateStreamFn} options.validateStream
   */
  constructor({ axiosInstance, baseUrl, validateStream }) {
    if (!baseUrl) {
      throw new Error('baseUrl is required for StreamService');
    }
    if (typeof validateStream !== 'function') {
      throw new Error('validateStream function is required for StreamService');
    }

    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.validateStream = validateStream;
    this.axiosInstance = axiosInstance || axios.create({
      timeout: parseInt(process.env.HTTP_TIMEOUT || '10000', 10),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; StreamService/1.0)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });

    this.cache = new QueryCacheService({ ttl: 300000, maxSize: 100 });
  }

  /**
   * Fetch live streams with optional category filter and pagination
   * @param {string} [categorySlug]
   * @param {number} [page=1]
   * @param {number} [limit=20]
   * @returns {Promise<PaginatedResponse<Stream>>}
   */
  async fetchLiveStreams(categorySlug, page = 1, limit = 20) {
    const params = new URLSearchParams();
    if (categorySlug) params.append('category', categorySlug);
    params.append('page', page.toString());
    params.append('limit', limit.toString());

    try {
      const response = await this.axiosInstance.get(`${this.baseUrl}/streams/live`, { params });
      const $ = cheerio.load(response.data);

      const streams = [];
      $('.stream-card, [data-stream-card], .stream-item').each((_, element) => {
        const stream = this.parseStreamCard($(element));
        if (stream) {
          const validation = this.validateStream(stream);
          if (validation.valid) {
            streams.push(validation.data);
          }
        }
      });

      const totalElements = parseInt($('.pagination .total, [data-total-count]').first().text() || streams.length, 10);
      const totalPages = Math.ceil(totalElements / limit);

      return {
        data: streams,
        pagination: {
          page,
          limit,
          totalElements,
          totalPages,
          hasNext: page < totalPages,
          hasPrev: page > 1,
        },
      };
    } catch (error) {
      throw StreamServiceError.fromAxiosError(error);
    }
  }

  /**
   * Search streams with query caching
   * @param {Object} params
   * @param {string} params.query
   * @param {string} [params.category]
   * @param {number} [params.page=1]
   * @param {number} [params.limit=20]
   * @param {string} [params.sortBy]
   * @param {string} [params.sortOrder]
   * @returns {Promise<PaginatedResponse<Stream>>}
   */
  async searchStreams(params) {
    const { query, category, page = 1, limit = 20, sortBy, sortOrder } = params;
    
    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      throw new StreamServiceError('Search query is required', 400, 'INVALID_QUERY');
    }

    const cacheKey = JSON.stringify({
      query: query.trim(),
      category,
      page,
      limit,
      sortBy,
      sortOrder,
    });

    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const searchParams = new URLSearchParams();
    searchParams.append('q', query.trim());
    if (category) searchParams.append('category', category);
    searchParams.append('page', page.toString());
    searchParams.append('limit', limit.toString());
    if (sortBy) searchParams.append('sortBy', sortBy);
    if (sortOrder) searchParams.append('sortOrder', sortOrder);

    try {
      const response = await this.axiosInstance.get(`${this.baseUrl}/streams/search`, { params: searchParams });
      const $ = cheerio.load(response.data);

      const streams = [];
      $('.stream-card, [data-stream-card], .stream-item, .search-result-item').each((_, element) => {
        const stream = this.parseStreamCard($(element));
        if (stream) {
          const validation = this.validateStream(stream);
          if (validation.valid) {
            streams.push(validation.data);
          }
        }
      });

      const totalElements = parseInt($('.pagination .total, [data-total-count], .results-count').first().text() || streams.length, 10);
      const totalPages = Math.ceil(totalElements / limit);

      const result = {
        data: streams,
        pagination: {
          page,
          limit,
          totalElements,
          totalPages,
          hasNext: page < totalPages,
          hasPrev: page > 1,
        },
      };

      this.cache.set(cacheKey,