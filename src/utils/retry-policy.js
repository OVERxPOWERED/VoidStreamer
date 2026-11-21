/**
 * Retry Policy Utility
 * Provides exponential backoff with jitter for resilient HTTP requests
 */

const DEFAULT_RETRYABLE_STATUS_CODES = [429, 500, 502, 503, 504];
const DEFAULT_RETRYABLE_ERROR_CODES = [
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'ENETUNREACH',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'EPIPE',
  'ESOCKETTIMEDOUT'
];

class RetryPolicy {
  /**
   * @param {Object} options
   * @param {number} options.maxRetries - Maximum number of retry attempts (default: 3)
   * @param {number} options.baseDelayMs - Base delay in milliseconds (default: 1000)
   * @param {number} options.maxDelayMs - Maximum delay cap in milliseconds (default: 30000)
   * @param {string} options.jitterType - Jitter strategy: 'full' | 'decorrelated' | 'none' (default: 'full')
   * @param {number[]} options.retryableStatusCodes - HTTP status codes to retry (default: [429, 500, 502, 503, 504])
   * @param {string[]} options.retryableErrorCodes - Node.js error codes to retry (default: network errors)
   * @param {Function} options.shouldRetry - Custom predicate: (error, attempt) => boolean
   * @param {Function} options.onRetry - Callback fired on each retry: (error, attempt, delayMs) => void
   */
  constructor(options = {}) {
    this.maxRetries = options.maxRetries ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 1000;
    this.maxDelayMs = options.maxDelayMs ?? 30000;
    this.jitterType = options.jitterType ?? 'full';
    this.retryableStatusCodes = options.retryableStatusCodes ?? DEFAULT_RETRYABLE_STATUS_CODES;
    this.retryableErrorCodes = options.retryableErrorCodes ?? DEFAULT_RETRYABLE_ERROR_CODES;
    this.shouldRetry = options.shouldRetry ?? this.defaultShouldRetry.bind(this);
    this.onRetry = options.onRetry ?? (() => {});
  }

  /**
   * Default retry predicate
   * @param {Error|Object} error
   * @param {number} attempt
   * @returns {boolean}
   */
  defaultShouldRetry(error, attempt) {
    if (attempt >= this.maxRetries) {
      return false;
    }

    // Axios error with response
    if (error?.response?.status) {
      return this.retryableStatusCodes.includes(error.response.status);
    }

    // Network/connection errors
    if (error?.code && this.retryableErrorCodes.includes(error.code)) {
      return true;
    }

    // Axios timeout
    if (error?.code === 'ECONNABORTED' || error?.message?.includes('timeout')) {
      return true;
    }

    // Generic network errors without specific codes
    if (error?.message && (
      error.message.includes('network') ||
      error.message.includes('socket') ||
      error.message.includes('connection')
    )) {
      return true;
    }

    return false;
  }

  /**
   * Calculate delay with exponential backoff and jitter
   * @param {number} attempt - Current attempt number (0-indexed)
   * @returns {number} Delay in milliseconds
   */
  calculateDelay(attempt) {
    const exponentialDelay = Math.min(
      this.baseDelayMs * Math.pow(2, attempt),
      this.maxDelayMs
    );

    switch (this.jitterType) {
      case 'full':
        // Full jitter: random value between 0 and exponential delay
        return Math.floor(Math.random() * exponentialDelay);

      case 'decorrelated':
        // Decorrelated jitter: random between baseDelay and previous delay * 3
        // For first attempt, use full jitter
        if (attempt === 0) {
          return Math.floor(Math.random() * exponentialDelay);
        }
        // This would need previous delay tracked; simplified here
        return Math.floor(Math.random() * Math.min(exponentialDelay * 3, this.maxDelayMs));

      case 'none':
      default:
        return exponentialDelay;
    }
  }

  /**
   * Execute a function with retry logic
   * @param {Function} fn - Async function to execute
   * @param {Object} context - Optional context for logging
   * @returns {Promise<any>} Result of the function
   */
  async execute(fn, context = {}) {
    let lastError;
    let attempt = 0;

    while (true) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;

        if (!this.shouldRetry(error, attempt)) {
          throw error;
        }

        const delayMs = this.calculateDelay(attempt);
        
        this.onRetry(error, attempt + 1, delayMs, context);

        await this.sleep(delayMs);
        attempt++;
      }
    }
  }

  /**
   * Sleep utility
   * @param {number} ms
   * @returns {Promise<void>}
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Create a wrapped version of an axios instance
   * @param {Object} axiosInstance - Axios instance (optional, uses default if not provided)
   * @returns {Object} Wrapped axios with retry
   */
  wrapAxios(axiosInstance) {
    const axios = axiosInstance || (() => {
      try {
        return require('axios');
      } catch {
        return null;
      }
    })();

    if (!axios) {
      throw new Error('Axios is required but not installed. Run: npm install axios');
    }

    const methods = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'request'];
    const wrapped = {};

    for (const method of methods) {
      wrapped[method] = (...args) => this.execute(() => axios[method](...args));
    }

    // Also expose the raw instance for advanced usage
    wrapped._axios = axios;
    wrapped._retryPolicy = this;

    return wrapped;
  }
}

/**
 * Factory function to create a RetryPolicy instance
 * @param {Object} options - RetryPolicy options
 * @returns {RetryPolicy}
 */
function createRetryPolicy(options = {}) {
  return new RetryPolicy(options);
}

/**
 * Default retry policy instance with sensible defaults
 * @type {RetryPolicy}
 */
const defaultRetryPolicy = createRetryPolicy();

module.exports = {
  RetryPolicy,
  createRetryPolicy,
  defaultRetryPolicy,
  DEFAULT_RETRYABLE_STATUS_CODES,
  DEFAULT_RETRYABLE_ERROR_CODES
};