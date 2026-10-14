const fs = require('fs');
const path = require('path');

const ENV_SCHEMA = {
  STREAM_SOURCES_CONFIG: {
    type: 'string',
    required: true,
    description: 'Path to stream sources configuration file (JSON/YAML)',
    validate: (value) => {
      if (!fs.existsSync(value)) {
        throw new Error(`STREAM_SOURCES_CONFIG file not found: ${value}`);
      }
      const ext = path.extname(value).toLowerCase();
      if (!['.json', '.yaml', '.yml'].includes(ext)) {
        throw new Error(`STREAM_SOURCES_CONFIG must be a JSON or YAML file, got: ${ext}`);
      }
      return value;
    }
  },
  CACHE_TTL_MS: {
    type: 'number',
    required: false,
    default: 300000,
    description: 'Cache TTL in milliseconds (default: 5 minutes)',
    validate: (value) => {
      const num = Number(value);
      if (isNaN(num) || num < 1000 || num > 86400000) {
        throw new Error('CACHE_TTL_MS must be a number between 1000 and 86400000 (1s - 24h)');
      }
      return num;
    }
  },
  REQUEST_TIMEOUT_MS: {
    type: 'number',
    required: false,
    default: 10000,
    description: 'HTTP request timeout in milliseconds (default: 10s)',
    validate: (value) => {
      const num = Number(value);
      if (isNaN(num) || num < 1000 || num > 120000) {
        throw new Error('REQUEST_TIMEOUT_MS must be a number between 1000 and 120000 (1s - 2min)');
      }
      return num;
    }
  },
  MAX_CONCURRENT_REQUESTS: {
    type: 'number',
    required: false,
    default: 10,
    description: 'Maximum concurrent HTTP requests (default: 10)',
    validate: (value) => {
      const num = Number(value);
      if (isNaN(num) || num < 1 || num > 100) {
        throw new Error('MAX_CONCURRENT_REQUESTS must be a number between 1 and 100');
      }
      return num;
    }
  },
  LOG_LEVEL: {
    type: 'string',
    required: false,
    default: 'info',
    description: 'Log level (debug, info, warn, error)',
    validate: (value) => {
      const validLevels = ['debug', 'info', 'warn', 'error'];
      const level = value.toLowerCase();
      if (!validLevels.includes(level)) {
        throw new Error(`LOG_LEVEL must be one of: ${validLevels.join(', ')}`);
      }
      return level;
    }
  },
  NODE_ENV: {
    type: 'string',
    required: false,
    default: 'development',
    description: 'Node environment',
    validate: (value) => {
      const validEnvs = ['development', 'production', 'test', 'staging'];
      if (!validEnvs.includes(value)) {
        throw new Error(`NODE_ENV must be one of: ${validEnvs.join(', ')}`);
      }
      return value;
    }
  }
};

let validatedConfig = null;
let isValidated = false;

function validateEnvironment() {
  if (isValidated) {
    return validatedConfig;
  }

  const errors = [];
  const config = {};

  for (const [key, schema] of Object.entries(ENV_SCHEMA)) {
    const rawValue = process.env[key];

    if (rawValue === undefined || rawValue === '') {
      if (schema.required) {
        errors.push(`Missing required environment variable: ${key} - ${schema.description}`);
        continue;
      }
      if (schema.default !== undefined) {
        config[key] = schema.default;
        continue;
      }
      config[key] = undefined;
      continue;
    }

    try {
      let parsedValue = rawValue;

      if (schema.type === 'number') {
        parsedValue = Number(rawValue);
        if (isNaN(parsedValue)) {
          throw new Error(`Expected number, got: ${rawValue}`);
        }
      } else if (schema.type === 'boolean') {
        parsedValue = rawValue === 'true' || rawValue === '1';
      }

      if (schema.validate) {
        parsedValue = schema.validate(parsedValue);
      }

      config[key] = parsedValue;
    } catch (error) {
      errors.push(`Invalid value for ${key}: ${error.message}`);
    }
  }

  if (errors.length > 0) {
    const errorMessage = [
      'Environment validation failed:',
      ...errors.map(e => `  - ${e}`),
      '',
      'Required variables:',
      ...Object.entries(ENV_SCHEMA)
        .filter(([, s]) => s.required)
        .map(([k, s]) => `  - ${k}: ${s.description}`)
    ].join('\n');

    throw new Error(errorMessage);
  }

  validatedConfig = Object.freeze(config);
  isValidated = true;

  console.log('[Environment] Validation successful. Config loaded:', {
    STREAM_SOURCES_CONFIG: config.STREAM_SOURCES_CONFIG,
    CACHE_TTL_MS: config.CACHE_TTL_MS,
    REQUEST_TIMEOUT_MS: config.REQUEST_TIMEOUT_MS,
    MAX_CONCURRENT_REQUESTS: config.MAX_CONCURRENT_REQUESTS,
    LOG_LEVEL: config.LOG_LEVEL,
    NODE_ENV: config.NODE_ENV
  });

  return validatedConfig;
}

function getConfig() {
  if (!isValidated) {
    return validateEnvironment();
  }
  return validatedConfig;
}

function resetValidation() {
  validatedConfig = null;
  isValidated = false;
}

module.exports = {
  validateEnvironment,
  getConfig,
  resetValidation,
  ENV_SCHEMA
};