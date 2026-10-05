const EventEmitter = require('events');
const axios = require('axios');
const {
  StreamConfig,
  StreamHealth,
  StreamQuality,
  Viewer,
  ChatMessage,
  Donation,
  Subscription,
  StreamEvent,
  StreamStatus,
  PlatformType
} = require('../types/domain');

class StreamDomainService extends EventEmitter {
  constructor() {
    super();
    this.streamConfig = null;
    this.streamStatus = StreamStatus.IDLE;
    this.currentQuality = StreamQuality.AUTO;
    this.viewers = new Map();
    this.chatHistory = [];
    this.donations = [];
    this.subscriptions = [];
    this.healthMetrics = {
      bitrate: 0,
      fps: 0,
      droppedFrames: 0,
      latency: 0,
      uptime: 0,
      viewerCount: 0,
      chatRate: 0,
      errorRate: 0
    };
    this.startTime = null;
    this.healthCheckInterval = null;
    this.platformClients = new Map();
    this.eventBuffer = [];
    this.maxEventBufferSize = 1000;
    this._setupEventHandlers();
  }

  _setupEventHandlers() {
    this.on('viewer:join', (viewer) => this._handleViewerJoinInternal(viewer));
    this.on('viewer:leave', (viewer) => this._handleViewerLeaveInternal(viewer));
    this.on('chat:message', (message) => this._processChatMessageInternal(message));
    this.on('donation:received', (donation) => this._processDonationInternal(donation));
    this.on('subscription:new', (sub) => this._processSubscriptionInternal(sub));
    this.on('stream:started', () => this._onStreamStarted());
    this.on('stream:stopped', () => this._onStreamStopped());
    this.on('quality:changed', (quality) => this._onQualityChanged(quality));
    this.on('health:update', (health) => this._onHealthUpdate(health));
    this.on('error', (error) => this._onError(error));
  }

  async initializeStream(config) {
    if (!(config instanceof StreamConfig)) {
      throw new Error('Invalid stream configuration');
    }

    this.streamConfig = config;
    this.streamStatus = StreamStatus.INITIALIZING;
    this.currentQuality = config.defaultQuality || StreamQuality.AUTO;
    this.viewers.clear();
    this.chatHistory = [];
    this.donations = [];
    this.subscriptions = [];
    this.healthMetrics = {
      bitrate: 0,
      fps: 0,
      droppedFrames: 0,
      latency: 0,
      uptime: 0,
      viewerCount: 0,
      chatRate: 0,
      errorRate: 0
    };

    await this._initializePlatformClients(config.platforms);
    await this._validateStreamConfiguration(config);

    this.emit('stream:initialized', { config: this.streamConfig });
    return { success: true, streamId: config.streamId };
  }

  async _initializePlatformClients(platforms) {
    for (const platform of platforms) {
      try {
        const client = await this._createPlatformClient(platform);
        this.platformClients.set(platform.type, client);
      } catch (error) {
        this.emit('error', { platform: platform.type, error: error.message });
      }
    }
  }

  async _createPlatformClient(platformConfig) {
    const baseURL = this._getPlatformBaseURL(platformConfig.type);
    const client = axios.create({
      baseURL,
      timeout: 10000,
      headers: {
        'Authorization': `Bearer ${platformConfig.accessToken}`,
        'Client-ID': platformConfig.clientId,
        'Content-Type': 'application/json'
      }
    });

    client.interceptors.response.use(
      response => response,
      error => {
        this.emit('platform:error', { platform: platformConfig.type, error: error.message });
        return Promise.reject(error);
      }
    );

    return client;
  }

  _getPlatformBaseURL(platformType) {
    const urls = {
      [PlatformType.TWITCH]: 'https://api.twitch.tv/helix',
      [PlatformType.YOUTUBE]: 'https://www.googleapis.com/youtube/v3',
      [PlatformType.FACEBOOK]: 'https://graph.facebook.com/v18.0',
      [PlatformType.TROVO]: 'https://open-api.trovo.live',
      [PlatformType.KICK]: 'https://api.kick.com/public/v1',
      [PlatformType.RUMBLE]: 'https://rumble.com/api',
      [PlatformType.CUSTOM]: ''
    };
    return urls[platformType] || '';
  }

  async _validateStreamConfiguration(config) {
    if (!config.streamKey) {
      throw new Error('Stream key is required');
    }
    if (!config.rtmpUrl) {
      throw new Error('RTMP URL is required');
    }
    if (config.platforms.length === 0) {
      throw new Error('At least one platform must be configured');
    }
  }

  async startStream() {
    if (this.streamStatus === StreamStatus.LIVE) {
      return { success: false, error: 'Stream is already live' };
    }

    if (!this.streamConfig) {
      return { success: false, error: 'Stream not initialized' };
    }

    this.streamStatus = StreamStatus.STARTING;
    this.startTime = Date.now();

    try {
      await this._startPlatformStreams();
      this.streamStatus = StreamStatus.LIVE;
      this._startHealthMonitoring();
      this.emit('stream:started', { streamId: this.streamConfig.streamId, startTime: this.startTime });
      return { success: true, streamId: this.streamConfig.streamId };
    } catch (error) {
      this.streamStatus = StreamStatus.ERROR;
      this.emit('error', { phase: 'start', error: error.message });
      return { success: false, error: error.message };
    }
  }

  async _startPlatformStreams() {
    const startPromises = Array.from(this.platformClients.entries()).map(
      async ([platform, client]) => {
        try {
          await this._startPlatformStream(platform, client);
        } catch (error) {
          this.emit('platform:start:error', { platform, error: error.message });
        }
      }
    );
    await Promise.allSettled(startPromises);
  }

  async _startPlatformStream(platform, client) {
    switch (platform) {
      case PlatformType.TWITCH:
        await client.post('/streams', { stream_key: this.streamConfig.streamKey });
        break;
      case PlatformType.YOUTUBE:
        await client.post('/liveBroadcasts', {
          part: 'snippet,status,contentDetails',
          broadcast: {
            snippet: { title: this.streamConfig.title },
            status: { privacyStatus: this.streamConfig.privacy || 'public' }
          }
        });
        break;
      case PlatformType.FACEBOOK:
        await client.post(`/${this.streamConfig.facebookPageId}/live_videos`, {
          title: this.streamConfig.title,
          stream_key: this.streamConfig.streamKey
        });
        break;
      case PlatformType.KICK:
        await client.post('/livestreams', {
          stream_key: this.streamConfig.streamKey,
          title: this.streamConfig.title
        });
        break;
      default:
        this.emit('platform:unsupported', { platform });
    }
  }

  async stopStream() {
    if (this.streamStatus !== StreamStatus.LIVE) {
      return { success: false, error: 'Stream is not live' };
    }

    this.streamStatus = StreamStatus.STOPPING;

    try {
      await