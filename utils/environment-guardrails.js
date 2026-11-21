```javascript
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
  UPSTREAM_SOURCES: {
    type: 'string',
    required: true,
    description: 'Comma-separated list of upstream source URLs or path to sources config',
    validate: (value) => {
      if (!value || value.trim() === '') {
        throw new Error('UPSTREAM_SOURCES cannot be empty');
      }
      return value.trim();
    }
  },
  PORT: {
    type: 'number',
    required: true,
    description: 'HTTP server port',
    validate: (value) => {
      const num = Number(value);
      if (isNaN(num) || num < 1 || num > 65535) {
        throw new Error('PORT must be a number between 1 and 65535');
      }
      return num;
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
  },
  CACHE_TTL: {
    type: 'number',
    required: false,
    default: 300000,
    description: 'Cache TTL in milliseconds (default: 5 minutes)',
    validate: (value) => {
      const num = Number(value);
      if (isNaN(num) || num < 1000 || num > 86400000) {
        throw new Error('CACHE_TTL must be a number between 1000 and 86400000 (1s - 24h)');
      }
      return num;
    }
  },
  CACHE_TTL_MS: {
    type: 'number',
    required: false,
    default: 300000,
    description: 'Cache TTL in milliseconds (default: 5 minutes) - alias for CACHE_TTL',
    validate: (value) => {
      const num = Number(value);
      if (isNaN(num) || num < 1000 || num > 86400000) {
        throw new Error('CACHE_TTL_MS must be a number between 1000 and 86400000 (1s - 24h)');
      }
      return num;
    }
  },
  RATE_LIMIT_WINDOW: {
    type: 'number',
    required: false,
    default: 60000,
    description: 'Rate limit window in milliseconds (default: 1 minute)',
    validate: (value) => {
      const num = Number(value);
      if (isNaN(num) || num < 1000 || num > 3600000) {
        throw new Error('RATE_LIMIT_WINDOW must be a number between 1000 and 3600000 (1s - 1h)');
      }
      return num;
    }
  },
  RATE_LIMIT_MAX: {
    type: 'number',
    required: false,
    default: 100,
    description: 'Maximum requests per rate limit window (default: 100)',
    validate: (value) => {
      const num = Number(value);
      if (isNaN(num) || num < 1 || num > 10000) {
        throw new Error('RATE_LIMIT_MAX must be a number between 1 and 10000');
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
  TELEMETRY_ENDPOINT: {
    type: 'string',
    required: false,
    default: '',
    description: 'OpenTelemetry collector endpoint (optional)',
    validate: (value) => {
      if (value && value.trim() !== '') {
        const url = value.trim();
        try {
          new URL(url);
        } catch {
          throw new Error('TELEMETRY_ENDPOINT must be a valid URL');
        }
        return url;
      }
      return '';
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