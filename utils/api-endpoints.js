const axios = require('axios');
const { validateSchema, sanitizeInput } = require('../utils/validation');

const startStreamSchema = {
  type: 'object',
  required: ['streamKey', 'platform', 'quality'],
  properties: {
    streamKey: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[a-zA-Z0-9_-]+$' },
    platform: { type: 'string', enum: ['youtube', 'twitch', 'facebook', 'rtmp', 'srt'] },
    quality: { type: 'string', enum: ['720p', '1080p', '4k', 'auto'] },
    title: { type: 'string', maxLength: 256, optional: true },
    description: { type: 'string', maxLength: 1024, optional: true },
    tags: { type: 'array', items: { type: 'string', maxLength: 64 }, maxItems: 10, optional: true },
    isPrivate: { type: 'boolean', optional: true },
    scheduledAt: { type: 'string', format: 'date-time', optional: true }
  },
  additionalProperties: false
};

const stopStreamSchema = {
  type: 'object',
  required: ['streamKey'],
  properties: {
    streamKey: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[a-zA-Z0-9_-]+$' },
    reason: { type: 'string', maxLength: 256, optional: true }
  },
  additionalProperties: false
};

const getStreamStatusSchema = {
  type: 'object',
  required: ['streamKey'],
  properties: {
    streamKey: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[a-zA-Z0-9_-]+$' },
    includeMetrics: { type: 'boolean', optional: true },
    includeHistory: { type: 'boolean', optional: true }
  },
  additionalProperties: false
};

const updateStreamConfigSchema = {
  type: 'object',
  required: ['streamKey'],
  properties: {
    streamKey: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[a-zA-Z0-9_-]+$' },
    bitrate: { type: 'integer', minimum: 500, maximum: 50000, optional: true },
    resolution: { type: 'string', enum: ['720p', '1080p', '4k'], optional: true },
    framerate: { type: 'integer', enum: [24, 30, 60], optional: true },
    codec: { type: 'string', enum: ['h264', 'h265', 'vp9', 'av1'], optional: true },
    audioBitrate: { type: 'integer', minimum: 64, maximum: 320, optional: true },
    audioCodec: { type: 'string', enum: ['aac', 'opus', 'mp3'], optional: true },
    keyframeInterval: { type: 'integer', minimum: 1, maximum: 10, optional: true },
    preset: { type: 'string', enum: ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'], optional: true }
  },
  additionalProperties: false
};

const endpointSchemas = {
  startStream: startStreamSchema,
  stopStream: stopStreamSchema,
  getStreamStatus: getStreamStatusSchema,
  updateStreamConfig: updateStreamConfigSchema
};

function createStandardResponse(success, data = null, error = null) {
  return {
    success,
    data,
    error,
    timestamp: new Date().toISOString()
  };
}

function handleError(res, error, statusCode = 500) {
  const errorResponse = createStandardResponse(false, null, {
    code: error.code || 'INTERNAL_ERROR',
    message: error.message || 'An unexpected error occurred',
    details: error.details || null
  });
  return res.status(statusCode).json(errorResponse);
}

async function makeExternalCall(url, options = {}) {
  try {
    const response = await axios({
      url,
      timeout: options.timeout || 10000,
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'StreamService/1.0',
        ...options.headers
      },
      data: options.data,
      params: options.params
    });
    return response.data;
  } catch (error) {
    if (error.response) {
      throw new Error(`External service error: ${error.response.status} - ${error.response.data?.message || error.message}`);
    } else if (error.request) {
      throw new Error('External service unavailable: No response received');
    } else {
      throw new Error(`External call failed: ${error.message}`);
    }
  }
}

function createEndpoints(services) {
  const { streamService, addInputSanitization, logger, metrics } = services;

  const sanitizeAndValidate = (schemaName) => {
    const schema = endpointSchemas[schemaName];
    return (req, res, next) => {
      try {
        const sanitized = addInputSanitization ? addInputSanitization(req.body) : req.body;
        const validation = validateSchema(sanitized, schema);
        if (!validation.valid) {
          return handleError(res, {
            code: 'VALIDATION_ERROR',
            message: 'Input validation failed',
            details: validation.errors
          }, 400);
        }
        req.validatedBody = validation.data;
        next();
      } catch (error) {
        return handleError(res, {
          code: 'SANITIZATION_ERROR',
          message: error.message
        }, 400);
      }
    };
  };

  async function startStream(req, res) {
    const startTime = Date.now();
    try {
      const { streamKey, platform, quality, title, description, tags, isPrivate, scheduledAt } = req.validatedBody;

      logger.info('Starting stream', { streamKey, platform, quality });

      const existingStream = await streamService.getStream(streamKey);
      if (existingStream && existingStream.status === 'live') {
        return handleError(res, {
          code: 'STREAM_ALREADY_LIVE',
          message: 'Stream is already live'
        }, 409);
      }

      const streamConfig = {
        streamKey,
        platform,
        quality,
        title: title || `Stream ${streamKey}`,
        description: description || '',
        tags: tags || [],
        isPrivate: isPrivate || false,
        scheduledAt: scheduledAt ? new Date(scheduledAt) : null
      };

      const result = await streamService.startStream(streamConfig);

      if (platform === 'rtmp' || platform === 'srt') {
        try {
          await makeExternalCall(`${process.env.RTMP_SERVER_URL}/api/stream/start`, {
            method: 'POST',
            data: { streamKey, platform, quality }
          });
        } catch (externalError) {
          logger.warn('External RTMP server notification failed', { error: externalError.message });
        }