const InputSanitizationService = require('../services/input-sanitization-service');

class StreamDomain {
  static StreamQuality = {
    AUTO: 'auto',
    HD_1080P: '1080p',
    HD_720P: '720p',
    SD_480P: '480p',
    SD_360P: '360p',
    LOW_240P: '240p',
    LOW_144P: '144p'
  };

  static ALLOWED_QUALITY_VALUES = Object.values(StreamDomain.StreamQuality);

  static createSource(rawSource) {
    const sanitized = InputSanitizationService.sanitizeStreamSource(rawSource);
    
    if (!sanitized.id || typeof sanitized.id !== 'string') {
      throw new Error('StreamSource must have a valid string id');
    }
    if (!sanitized.name || typeof sanitized.name !== 'string') {
      throw new Error('StreamSource must have a valid string name');
    }
    if (!sanitized.baseUrl || typeof sanitized.baseUrl !== 'string') {
      throw new Error('StreamSource must have a valid string baseUrl');
    }
    if (typeof sanitized.isActive !== 'boolean') {
      throw new Error('StreamSource isActive must be a boolean');
    }
    if (typeof sanitized.priority !== 'number' || sanitized.priority < 0) {
      throw new Error('StreamSource priority must be a non-negative number');
    }

    return Object.freeze({
      id: sanitized.id,
      name: sanitized.name,
      baseUrl: sanitized.baseUrl,
      isActive: sanitized.isActive,
      priority: sanitized.priority
    });
  }

  static createMetadata(rawMetadata) {
    const sanitized = InputSanitizationService.sanitizeStreamMetadata(rawMetadata);
    
    if (!sanitized.title || typeof sanitized.title !== 'string') {
      throw new Error('StreamMetadata must have a valid string title');
    }
    if (!sanitized.url || typeof sanitized.url !== 'string') {
      throw new Error('StreamMetadata must have a valid string url');
    }
    if (!sanitized.quality || !StreamDomain.ALLOWED_QUALITY_VALUES.includes(sanitized.quality)) {
      throw new Error(`StreamMetadata quality must be one of: ${StreamDomain.ALLOWED_QUALITY_VALUES.join(', ')}`);
    }
    if (!sanitized.sourceId || typeof sanitized.sourceId !== 'string') {
      throw new Error('StreamMetadata must have a valid string sourceId');
    }
    if (!sanitized.timestamp || !(sanitized.timestamp instanceof Date) && typeof sanitized.timestamp !== 'number') {
      throw new Error('StreamMetadata must have a valid timestamp (Date or number)');
    }
    if (sanitized.headers && typeof sanitized.headers !== 'object') {
      throw new Error('StreamMetadata headers must be an object');
    }

    return Object.freeze({
      title: sanitized.title,
      url: sanitized.url,
      quality: sanitized.quality,
      sourceId: sanitized.sourceId,
      timestamp: sanitized.timestamp instanceof Date ? sanitized.timestamp : new Date(sanitized.timestamp),
      headers: sanitized.headers || {}
    });
  }
}

module.exports = {
  StreamDomain,
  StreamSource: 'StreamSource',
  StreamQuality: StreamDomain.StreamQuality,
  StreamMetadata: 'StreamMetadata'
};