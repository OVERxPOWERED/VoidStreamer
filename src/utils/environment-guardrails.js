```javascript
const axios = require('axios');

class EnvironmentGuardrails {
  constructor(options = {}) {
    this.config = {};
    this.errors = [];
    this.warnings = [];
    this.schema = this._buildSchema();
    this.defaults = this._getDefaults(options.nodeEnv || process.env.NODE_ENV || 'development');
  }

  _buildSchema() {
    return {
      STREAM_KEY: {
        required: true,
        type: 'string',
        minLength: 16,
        maxLength: 128,
        pattern: /^[a-zA-Z0-9_-]+$/,
        description: 'Stream authentication key (alphanumeric, underscore, hyphen)'
      },
      PLATFORM_API_KEY: {
        required: true,
        type: 'string',
        minLength: 32,
        maxLength: 256,
        pattern: /^[a-zA-Z0-9._-]+$/,
        description: 'Platform API key for service authentication'
      },
      CDN_ENDPOINT: {
        required: true,
        type: 'string',
        format: 'url',
        protocols: ['https'],
        description: 'CDN endpoint URL (HTTPS required)'
      },
      MAX_BITRATE: {
        required: true,
        type: 'number',
        min: 500,
        max: 50000,
        description: 'Maximum bitrate in kbps (500-50000)'
      },
      CHUNK_DURATION: {
        required: true,
        type: 'number',
        min: 1,
        max: 30,
        description: 'Segment chunk duration in seconds (1-30)'
      },
      NODE_ENV: {
        required: false,
        type: 'string',
        enum: ['development', 'staging', 'production', 'test'],
        default: 'development',
        description: 'Runtime environment'
      },
      LOG_LEVEL: {
        required: false,
        type: 'string',
        enum: ['error', 'warn', 'info', 'debug', 'trace'],
        default: 'info',
        description: 'Logging verbosity level'
      },
      ENABLE_METRICS: {
        required: false,
        type: 'boolean',
        default: true,
        description: 'Enable metrics collection'
      },
      HEALTH_CHECK_INTERVAL: {
        required: false,
        type: 'number',
        min: 5,
        max: 300,
        default: 30,
        description: 'Health check interval in seconds'
      },
      RETRY_ATTEMPTS: {
        required: false,
        type: 'number',
        min: 0,
        max: 10,
        default: 3,
        description: 'Number of retry attempts for failed operations'
      },
      RETRY_DELAY_MS: {
        required: false,
        type: 'number',
        min: 100,
        max: 30000,
        default: 1000,
        description: 'Base delay between retries in milliseconds'
      }
    };
  }

  _getDefaults(nodeEnv) {
    const baseDefaults = {
      NODE_ENV: nodeEnv,
      LOG_LEVEL: nodeEnv === 'production' ? 'warn' : 'debug',
      ENABLE_METRICS: nodeEnv !== 'test',
      HEALTH_CHECK_INTERVAL: nodeEnv === 'production' ? 15 : 60,
      RETRY_ATTEMPTS: nodeEnv === 'production' ? 5 : 2,
      RETRY_DELAY_MS: nodeEnv === 'production' ? 500 : 2000
    };

    const envSpecificDefaults = {
      development: {
        MAX_BITRATE: 5000,
        CHUNK_DURATION: 6
      },
      staging: {
        MAX_BITRATE: 8000,
        CHUNK_DURATION: 4
      },
      production: {
        MAX_BITRATE: 12000,
        CHUNK_DURATION: 2
      },
      test: {
        MAX_BITRATE: 1000,
        CHUNK_DURATION: 10
      }
    };

    return { ...baseDefaults, ...(envSpecificDefaults[nodeEnv] || envSpecificDefaults.development) };
  }

  validateField(key, value) {
    const rule = this.schema[key];
    if (!rule) {
      this.warnings.push(`Unknown configuration key: ${key}`);
      return true;
    }

    if (value === undefined || value === null || value === '') {
      if (rule.required) {
        this.errors.push(`Missing required environment variable: ${key} - ${rule.description}`);
        return false;
      }
      if (rule.default !== undefined) {
        this.config[key] = rule.default;
        return true;
      }
      return true;
    }

    const typeCheck = this._validateType(key, value, rule);
    if (!typeCheck.valid) {
      this.errors.push(typeCheck.message);
      return false;
    }

    const constraintCheck = this._validateConstraints(key, value, rule);
    if (!constraintCheck.valid) {
      this.errors.push(constraintCheck.message);
      return false;
    }

    this.config[key] = typeCheck.coercedValue;
    return true;
  }

  _validateType(key, value, rule) {
    switch (rule.type) {
      case 'string': {
        const strValue = String(value);
        if (rule.format === 'url') {
          try {
            const url = new URL(strValue);
            if (rule.protocols && !rule.protocols.includes(url.protocol.replace(':', ''))) {
              return { valid: false, message: `${key} must use one of: ${rule.protocols.join(', ')}` };
            }
            return { valid: true, coercedValue: strValue };
          } catch {
            return { valid: false, message: `${key} must be a valid URL` };
          }
        }
        if (rule.enum && !rule.enum.includes(strValue)) {
          return { valid: false, message: `${key} must be one of: ${rule.enum.join(', ')}` };
        }
        if (rule.pattern && !rule.pattern.test(strValue)) {
          return { valid: false, message: `${key} format is invalid: ${rule.description}` };
        }
        return { valid: true, coercedValue: strValue };
      }
      case 'number': {
        const numValue = Number(value);
        if (isNaN(numValue)) {
          return { valid: false, message: `${key} must be a valid number` };
        }
        if (!Number.isInteger(numValue) && key !== 'MAX_BITRATE') {
          return { valid: false, message: `${key} must be an integer` };
        }
        return { valid: true, coercedValue: numValue };
      }
      case 'boolean': {
        if (typeof value === 'boolean') return { valid: true, coercedValue: value };
        if (value === 'true' || value === '1') return { valid: true, coercedValue: true };
        if (value === 'false' || value === '0') return { valid: true, coercedValue: false };
        return { valid: false, message: `${key