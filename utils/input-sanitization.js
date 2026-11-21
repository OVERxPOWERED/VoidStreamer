```javascript
const cheerio = require('cheerio');

class InputSanitizer {
  static readonly STREAM_KEY_PATTERN = /^[a-zA-Z0-9_-]{1,100}$/;
  static readonly USERNAME_PATTERN = /^[a-zA-Z0-9_-]{1,32}$/;
  static readonly URL_PATTERN = /^https?:\/\/(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(?:\/[^\s]*)?$/;
  static readonly VALID_RESOLUTIONS = ['1920x1080', '1280x720', '854x480', '640x360', '426x240'];
  static readonly MIN_BITRATE = 500;
  static readonly MAX_BITRATE = 20000;
  static readonly MAX_CHAT_MESSAGE_LENGTH = 500;
  static readonly MAX_JSON_PAYLOAD_SIZE = 1024 * 1024;

  static sanitizeStreamKey(key) {
    if (typeof key !== 'string') {
      throw new Error('Stream key must be a string');
    }
    const trimmed = key.trim();
    if (!this.STREAM_KEY_PATTERN.test(trimmed)) {
      throw new Error('Invalid stream key format. Only alphanumeric, underscore, and hyphen allowed (1-100 chars)');
    }
    return trimmed;
  }

  static sanitizeChatMessage(msg) {
    if (typeof msg !== 'string') {
      throw new Error('Chat message must be a string');
    }
    const trimmed = msg.trim();
    if (trimmed.length === 0) {
      throw new Error('Chat message cannot be empty');
    }
    if (trimmed.length > this.MAX_CHAT_MESSAGE_LENGTH) {
      throw new Error(`Chat message exceeds maximum length of ${this.MAX_CHAT_MESSAGE_LENGTH} characters`);
    }
    return this.sanitizeHtml(trimmed);
  }

  static sanitizeUsername(name) {
    if (typeof name !== 'string') {
      throw new Error('Username must be a string');
    }
    const trimmed = name.trim();
    if (!this.USERNAME_PATTERN.test(trimmed)) {
      throw new Error('Invalid username format. Only alphanumeric, underscore, and hyphen allowed (1-32 chars)');
    }
    return trimmed;
  }

  static sanitizeUrl(url) {
    if (typeof url !== 'string') {
      throw new Error('URL must be a string');
    }
    const trimmed = url.trim();
    if (!this.URL_PATTERN.test(trimmed)) {
      throw new Error('Invalid URL format. Must be a valid HTTP/HTTPS URL');
    }
    try {
      const parsed = new URL(trimmed);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('Only HTTP and HTTPS protocols are allowed');
      }
      return trimmed;
    } catch (error) {
      if (error instanceof TypeError) {
        throw new Error('Invalid URL format');
      }
      throw error;
    }
  }

  static validateBitrate(rate) {
    const numRate = Number(rate);
    if (isNaN(numRate) || !Number.isInteger(numRate)) {
      throw new Error('Bitrate must be an integer');
    }
    if (numRate < this.MIN_BITRATE || numRate > this.MAX_BITRATE) {
      throw new Error(`Bitrate must be between ${this.MIN_BITRATE} and ${this.MAX_BITRATE} kbps`);
    }
    return numRate;
  }

  static validateResolution(res) {
    if (typeof res !== 'string') {
      throw new Error('Resolution must be a string');
    }
    const trimmed = res.trim().toLowerCase();
    if (!this.VALID_RESOLUTIONS.includes(trimmed)) {
      throw new Error(`Invalid resolution. Must be one of: ${this.VALID_RESOLUTIONS.join(', ')}`);
    }
    return trimmed;
  }

  static sanitizeJsonPayload(payload) {
    if (typeof payload !== 'object' || payload === null) {
      throw new Error('Payload must be a valid JSON object');
    }
    const jsonString = JSON.stringify(payload);
    if (jsonString.length > this.MAX_JSON_PAYLOAD_SIZE) {
      throw new Error(`JSON payload exceeds maximum size of ${this.MAX_JSON_PAYLOAD_SIZE} bytes`);
    }
    return this.deepSanitizeObject(payload);
  }

  static sanitizeHtml(html) {
    const $ = cheerio.load(html, {
      decodeEntities: true,
      xmlMode: false
    });
    
    $('script, style, iframe, object, embed, form, input, button, select, textarea').remove();
    
    $('*').each((_, element) => {
      const el = $(element);
      const attrs = el.attr();
      if (attrs) {
        Object.keys(attrs).forEach(attr => {
          if (attr.startsWith('on') || attr === 'href' || attr === 'src') {
            const value = attrs[attr];
            if (value && (value.startsWith('javascript:') || value.startsWith('data:'))) {
              el.removeAttr(attr);
            }
          }
        });
      }
    });
    
    return $.html().trim();
  }

  static deepSanitizeObject(obj, depth = 0) {
    if (depth > 10) {
      throw new Error('Object nesting too deep');
    }
    
    if (Array.isArray(obj)) {
      return obj.map(item => this.deepSanitizeObject(item, depth + 1));
    }
    
    if (typeof obj === 'object' && obj !== null) {
      const sanitized = {};
      for (const [key, value] of Object.entries(obj)) {
        const cleanKey = this.sanitizeHtml(key);
        if (typeof value === 'string') {
          sanitized[cleanKey] = this.sanitizeHtml(value);
        } else if (typeof value === 'object' && value !== null) {
          sanitized[cleanKey] = this.deepSanitizeObject(value, depth + 1);
        } else {
          sanitized[cleanKey] = value;
        }
      }
      return sanitized;
    }
    
    if (typeof obj === 'string') {
      return this.sanitizeHtml(obj);
    }
    
    return obj;
  }

  static sanitize(input, type) {
    switch (type) {
      case 'streamKey':
        return this.sanitizeStreamKey(input);
      case 'chatMessage':
        return this.sanitizeChatMessage(input);
      case 'username':
        return this.sanitizeUsername(input);
      case 'url':
        return this.sanitizeUrl(input);
      case 'html':
        return this.sanitizeHtml(input);
      case 'json':
        return this.sanitizeJsonPayload(input);
      default:
        throw new Error(`Unknown sanitization type: ${type}`);
    }
  }

  static validate(input, type) {
    switch (type) {
      case 'bitrate':
        return this.validateBitrate(input);
      case 'resolution':
        return this.validateResolution(input);
      case 'streamKey':
        return this.sanitizeStreamKey(input);
      case 'username':
        return this.sanitizeUsername(input);
      case 'url':
        return this.sanitizeUrl(input);
      default:
        throw new Error(`Unknown validation type: ${type}`);
    }
  }
}

function sanitize