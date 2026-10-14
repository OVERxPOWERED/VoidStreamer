```javascript
/**
 * InputSanitizationService - Secure parameter validation for stream operations
 * Provides comprehensive input sanitization with allowlist-based validation
 * and protection against injection attacks, XSS, and path traversal.
 */

const ALLOWED_SEARCH_CHARS = /^[a-zA-Z0-9\s\-_.,!?()]+$/;
const ALLOWED_SOURCE_ID_CHARS = /^[a-zA-Z0-9\-_]+$/;
const ALLOWED_QUALITY_VALUES = ['auto', '4k', '2160p', '1080p', '720p', '480p', '360p', '240p', '144p'];
const MAX_SEARCH_LENGTH = 200;
const MAX_SOURCE_ID_LENGTH = 100;
const MAX_PAGE = 1000;
const MAX_LIMIT = 100;

const SQL_INJECTION_PATTERNS = [
  /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|UNION|ALTER|CREATE|EXEC|EXECUTE)\b)/i,
  /(--|\/\*|\*\/|;|'|"|`)/,
  /(\b(OR|AND)\b\s+\d+\s*=\s*\d+)/i,
  /(\b(OR|AND)\b\s+['"]\w+['"]\s*=\s*['"]\w+['"])/i,
];

const XSS_PATTERNS = [
  /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
  /<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi,
  /javascript:/gi,
  /on\w+\s*=/gi,
  /<img[^>]+onerror/gi,
  /<svg[^>]+onload/gi,
];

const PATH_TRAVERSAL_PATTERNS = [
  /\.\.\//g,
  /\.\.\\/g,
  /%2e%2e%2f/gi,
  /%2e%2e%5c/gi,
  /\.\.%2f/gi,
  /\.\.%5c/gi,
];

class InputSanitizationService {
  constructor() {
    this.compiledPatterns = {
      sql: SQL_INJECTION_PATTERNS.map(p => new RegExp(p)),
      xss: XSS_PATTERNS.map(p => new RegExp(p)),
      pathTraversal: PATH_TRAVERSAL_PATTERNS.map(p => new RegExp(p)),
    };
  }

  /**
   * Validates input against dangerous patterns
   * @param {string} input - Input to validate
   * @param {string} context - Context for error messages
   * @throws {Error} If dangerous patterns detected
   */
  _validateSecurity(input, context) {
    if (typeof input !== 'string') {
      throw new Error(`${context}: Input must be a string`);
    }

    for (const pattern of this.compiledPatterns.sql) {
      if (pattern.test(input)) {
        throw new Error(`${context}: Potential SQL injection detected`);
      }
    }

    for (const pattern of this.compiledPatterns.xss) {
      if (pattern.test(input)) {
        throw new Error(`${context}: Potential XSS vector detected`);
      }
    }

    for (const pattern of this.compiledPatterns.pathTraversal) {
      if (pattern.test(input)) {
        throw new Error(`${context}: Potential path traversal detected`);
      }
    }
  }

  /**
   * Sanitizes search query input
   * @param {string} query - Search query string
   * @returns {string} Sanitized query
   * @throws {Error} If validation fails
   */
  sanitizeSearchQuery(query) {
    if (!query || typeof query !== 'string') {
      throw new Error('Search query is required and must be a string');
    }

    const trimmed = query.trim();
    
    if (trimmed.length === 0) {
      throw new Error('Search query cannot be empty');
    }

    if (trimmed.length > MAX_SEARCH_LENGTH) {
      throw new Error(`Search query exceeds maximum length of ${MAX_SEARCH_LENGTH} characters`);
    }

    this._validateSecurity(trimmed, 'Search query');

    if (!ALLOWED_SEARCH_CHARS.test(trimmed)) {
      throw new Error('Search query contains invalid characters. Only alphanumeric, spaces, hyphens, underscores, and basic punctuation allowed');
    }

    return trimmed.replace(/\s+/g, ' ');
  }

  /**
   * Sanitizes source ID input
   * @param {string} sourceId - Source identifier
   * @returns {string} Sanitized source ID
   * @throws {Error} If validation fails
   */
  sanitizeSourceId(sourceId) {
    if (!sourceId || typeof sourceId !== 'string') {
      throw new Error('Source ID is required and must be a string');
    }

    const trimmed = sourceId.trim();

    if (trimmed.length === 0) {
      throw new Error('Source ID cannot be empty');
    }

    if (trimmed.length > MAX_SOURCE_ID_LENGTH) {
      throw new Error(`Source ID exceeds maximum length of ${MAX_SOURCE_ID_LENGTH} characters`);
    }

    this._validateSecurity(trimmed, 'Source ID');

    if (!ALLOWED_SOURCE_ID_CHARS.test(trimmed)) {
      throw new Error('Source ID contains invalid characters. Only alphanumeric, hyphens, and underscores allowed');
    }

    return trimmed;
  }

  /**
   * Sanitizes quality parameter
   * @param {string} quality - Quality parameter
   * @returns {string} Validated quality value
   * @throws {Error} If validation fails
   */
  sanitizeQualityParam(quality) {
    if (!quality || typeof quality !== 'string') {
      return 'auto';
    }

    const trimmed = quality.trim().toLowerCase();

    if (!ALLOWED_QUALITY_VALUES.includes(trimmed)) {
      throw new Error(`Invalid quality value. Allowed values: ${ALLOWED_QUALITY_VALUES.join(', ')}`);
    }

    this._validateSecurity(trimmed, 'Quality parameter');

    return trimmed;
  }

  /**
   * Validates pagination parameters
   * @param {Object} params - Pagination parameters
   * @param {number|string} params.page - Page number (1-based)
   * @param {number|string} params.limit - Items per page
   * @returns {Object} Validated pagination params { page, limit, offset }
   * @throws {Error} If validation fails
   */
  validatePaginationParams({ page = 1, limit = 20 }) {
    const parsedPage = parseInt(page, 10);
    const parsedLimit = parseInt(limit, 10);

    if (isNaN(parsedPage) || parsedPage < 1) {
      throw new Error('Page must be a positive integer');
    }

    if (isNaN(parsedLimit) || parsedLimit < 1) {
      throw new Error('Limit must be a positive integer');
    }

    if (parsedPage > MAX_PAGE) {
      throw new Error(`Page cannot