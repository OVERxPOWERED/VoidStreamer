class ValidationError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
    Error.captureStackTrace(this, this.constructor);
  }
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NUMERIC_ID_REGEX = /^\d+$/;
const HTML_TAG_REGEX = /<[^>]*>/g;
const SPECIAL_CHARS_REGEX = /[<>&"']/g;

const HTML_ESCAPE_MAP = {
  '<': '&lt;',
  '>': '&gt;',
  '&': '&amp;',
  '"': '&quot;',
  "'": '&#x27;'
};

function sanitizeString(input, maxLength = 256) {
  if (typeof input !== 'string') {
    throw new ValidationError('Input must be a string', 'INVALID_TYPE');
  }

  let sanitized = input
    .replace(HTML_TAG_REGEX, '')
    .replace(SPECIAL_CHARS_REGEX, (char) => HTML_ESCAPE_MAP[char]);

  sanitized = sanitized.trim();

  if (sanitized.length > maxLength) {
    sanitized = sanitized.slice(0, maxLength);
  }

  return sanitized;
}

function validateStreamerId(id) {
  if (id === undefined || id === null) {
    throw new ValidationError('Streamer ID is required', 'MISSING_STREAMER_ID');
  }

  const idString = String(id).trim();

  if (!idString) {
    throw new ValidationError('Streamer ID cannot be empty', 'EMPTY_STREAMER_ID');
  }

  const isUuid = UUID_REGEX.test(idString);
  const isNumeric = NUMERIC_ID_REGEX.test(idString);

  if (!isUuid && !isNumeric) {
    throw new ValidationError(
      'Streamer ID must be a valid UUID or numeric ID',
      'INVALID_STREAMER_ID_FORMAT'
    );
  }

  return idString;
}

function validateSessionParams(params) {
  if (!params || typeof params !== 'object') {
    throw new ValidationError('Session parameters must be an object', 'INVALID_PARAMS_TYPE');
  }

  if (!params.streamerId) {
    throw new ValidationError('streamerId is required', 'MISSING_STREAMER_ID');
  }

  if (!params.category) {
    throw new ValidationError('category is required', 'MISSING_CATEGORY');
  }

  validateStreamerId(params.streamerId);

  const validCategories = ['gaming', 'music', 'talk', 'art', 'irl', 'education', 'other'];
  const category = sanitizeString(params.category, 50).toLowerCase();

  if (!validCategories.includes(category)) {
    throw new ValidationError(
      `Invalid category. Must be one of: ${validCategories.join(', ')}`,
      'INVALID_CATEGORY'
    );
  }

  return {
    streamerId: params.streamerId,
    category,
    title: params.title ? sanitizeString(params.title, 128) : undefined,
    tags: Array.isArray(params.tags)
      ? params.tags.slice(0, 10).map(tag => sanitizeString(tag, 32))
      : []
  };
}

function validatePagination(page, limit) {
  const parsedPage = parseInt(page, 10);
  const parsedLimit = parseInt(limit, 10);

  if (isNaN(parsedPage) || parsedPage < 1) {
    throw new ValidationError('Page must be a positive integer >= 1', 'INVALID_PAGE');
  }

  if (isNaN(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
    throw new ValidationError('Limit must be an integer between 1 and 100', 'INVALID_LIMIT');
  }

  return { page: parsedPage, limit: parsedLimit };
}

module.exports = {
  ValidationError,
  sanitizeString,
  validateStreamerId,
  validateSessionParams,
  validatePagination
};