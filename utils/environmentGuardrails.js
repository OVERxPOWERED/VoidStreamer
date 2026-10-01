const axios = require('axios');
const cheerio = require('cheerio');
const semver = require('semver');

const REQUIRED_ENV_VARS = {
  STREAM_API_BASE_URL: {
    type: 'url',
    required: true,
    description: 'Base URL for the streaming API'
  },
  SCRAPER_USER_AGENT: {
    type: 'string',
    required: true,
    description: 'User agent string for web scraping'
  },
  REQUEST_TIMEOUT_MS: {
    type: 'positiveInteger',
    required: true,
    description: 'Request timeout in milliseconds'
  },
  CACHE_TTL_SECONDS: {
    type: 'positiveInteger',
    required: true,
    description: 'Cache TTL in seconds'
  },
  LOG_LEVEL: {
    type: 'enum',
    required: true,
    enum: ['error', 'warn', 'info', 'debug', 'trace'],
    description: 'Logging level'
  }
};

const OPTIONAL_ENV_VARS = {
  NODE_ENV: {
    type: 'enum',
    required: false,
    enum: ['development', 'production', 'test'],
    default: 'development',
    description: 'Node environment'
  },
  REDIS_URL: {
    type: 'url',
    required: false,
    default: null,
    description: 'Redis connection URL'
  },
  MAX_RETRIES: {
    type: 'positiveInteger',
    required: false,
    default: 3,
    description: 'Maximum retry attempts'
  },
  RETRY_DELAY_MS: {
    type: 'positiveInteger',
    required: false,
    default: 1000,
    description: 'Delay between retries in milliseconds'
  }
};

const DEPENDENCY_VERSIONS = {
  axios: '^1.6.0',
  cheerio: '^1.0.0'
};

function validateUrl(value, varName) {
  try {
    new URL(value);
    return true;
  } catch {
    throw new Error(`Invalid URL format for ${varName}: "${value}"`);
  }
}

function validatePositiveInteger(value, varName) {
  const num = parseInt(value, 10);
  if (isNaN(num) || num <= 0 || !Number.isInteger(num)) {
    throw new Error(`Invalid positive integer for ${varName}: "${value}"`);
  }
  return true;
}

function validateEnum(value, varName, allowedValues) {
  if (!allowedValues.includes(value)) {
    throw new Error(`Invalid value for ${varName}: "${value}". Allowed values: ${allowedValues.join(', ')}`);
  }
  return true;
}

function validateString(value, varName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid string for ${varName}: "${value}"`);
  }
  return true;
}

const VALIDATORS = {
  url: validateUrl,
  positiveInteger: validatePositiveInteger,
  enum: validateEnum,
  string: validateString
};

function validateEnvironment() {
  const errors = [];
  const config = {};

  for (const [varName, schema] of Object.entries(REQUIRED_ENV_VARS)) {
    const value = process.env[varName];
    
    if (value === undefined || value === '') {
      errors.push(`Missing required environment variable: ${varName} (${schema.description})`);
      continue;
    }

    try {
      VALIDATORS[schema.type](value, varName, schema.enum);
      config[varName] = schema.type === 'positiveInteger' ? parseInt(value, 10) : value;
    } catch (error) {
      errors.push(error.message);
    }
  }

  for (const [varName, schema] of Object.entries(OPTIONAL_ENV_VARS)) {
    const value = process.env[varName];
    
    if (value === undefined || value === '') {
      if (schema.default !== null && schema.default !== undefined) {
        config[varName] = schema.default;
      } else {
        config[varName] = null;
      }
      continue;
    }

    try {
      VALIDATORS[schema.type](value, varName, schema.enum);
      config[varName] = schema.type === 'positiveInteger' ? parseInt(value, 10) : value;
    } catch (error) {
      errors.push(error.message);
    }
  }

  if (errors.length > 0) {
    const errorMessage = `Environment validation failed:\n${errors.map(e => `  - ${e}`).join('\n')}`;
    throw new Error(errorMessage);
  }

  return config;
}

function getConfig() {
  const config = validateEnvironment();
  return Object.freeze(config);
}

function validateRuntimeDependencies() {
  const errors = [];
  const warnings = [];

  for (const [depName, range] of Object.entries(DEPENDENCY_VERSIONS)) {
    let installedVersion;
    
    try {
      if (depName === 'axios') {
        installedVersion = axios.VERSION || require('axios/package.json').version;
      } else if (depName === 'cheerio') {
        installedVersion = cheerio.version || require('cheerio/package.json').version;
      }
    } catch {
      errors.push(`Failed to determine version for ${depName}`);
      continue;
    }

    if (!installedVersion) {
      errors.push(`Could not determine installed version for ${depName}`);
      continue;
    }

    if (!semver.satisfies(installedVersion, range)) {
      errors.push(
        `Dependency version mismatch for ${depName}: ` +
        `installed ${installedVersion} does not satisfy required range ${range}`
      );
    } else if (semver.major(installedVersion) > semver.major(range.replace(/^\^/, ''))) {
      warnings.push(
        `Warning: ${depName} version ${installedVersion} is newer than tested range ${range}. ` +
        `Consider updating the required range after verification.`
      );
    }
  }

  if (errors.length > 0) {
    const errorMessage = `Runtime dependency validation failed:\n${errors.map(e => `  - ${e}`).join('\n')}`;
    throw new Error(errorMessage);
  }

  if (warnings.length > 0) {
    console.warn(`Dependency warnings:\n${warnings.map(w => `  - ${w}`).join('\n')}`);
  }

  return true;
}

module.exports = {
  validateEnvironment,
  getConfig,
  validateRuntimeDependencies
};