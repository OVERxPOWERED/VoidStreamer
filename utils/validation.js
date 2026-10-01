```javascript
const cheerio = require('cheerio');

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
const URL_REGEX = /^https?:\/\/(?:www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b(?:[-a-zA-Z0-9()@:%_\+.~#?&\/=]*)$/;

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

function sanitizeHtml(input) {
  if (typeof input !== 'string') {
    return '';
  }
  const $ = cheerio.load(input, { decodeEntities: false });
  return $.text().trim();
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

function createSchemaBuilder(schemaDefinition) {
  const validators = schemaDefinition;

  function parse(data) {
    const result = safeParse(data);
    if (!result.success) {
      const error = new ValidationError(result.errors.join('; '), 'VALIDATION_FAILED');
      error.errors = result.errors;
      throw error;
    }
    return result.data;
  }

  function safeParse(data) {
    const errors = [];
    const result = {};

    for (const [key, validator] of Object.entries(validators)) {
      const value = data[key];
      try {
        result[key] = validator(value, data);
      } catch (err) {
        if (err instanceof ValidationError) {
          errors.push(`${key}: ${err.message}`);
        } else {
          errors.push(`${key}: ${err.message}`);
        }
      }
    }

    if (errors.length > 0) {
      return { success: false, errors };
    }
    return { success: true, data: result };
  }

  function validate(data) {
    const result = safeParse(data);
    return {
      success: result.success,
      data: result.data,
      errors: result.errors
    };
  }

  return { parse, safeParse, validate };
}

function createStreamSchema() {
  return createSchemaBuilder({
    id: (value) => {
      if (!value) throw new ValidationError('Stream ID is required', 'MISSING_ID');
      const idStr = String(value).trim();
      if (!idStr) throw new ValidationError('Stream ID cannot be empty', 'EMPTY_ID');
      if (!UUID_REGEX.test(idStr) && !NUMERIC_ID_REGEX.test(idStr)) {
        throw new ValidationError('Stream ID must be a valid UUID or numeric ID', 'INVALID_ID_FORMAT');
      }
      return idStr;
    },
    streamerId: (value) => {
      if (!value) throw new ValidationError('Streamer ID is required', 'MISSING_STREAMER_ID');
      return validateStreamerId(value);
    },
    title: (value) => {
      if (!value) throw new ValidationError('Title is required', 'MISSING_TITLE');
      const sanitized = sanitizeHtml(String(value));
      if (sanitized.length > 200) {
        throw new ValidationError('Title must not exceed 200 characters', 'TITLE_TOO_LONG');