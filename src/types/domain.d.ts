import { BaseEntity } from '../types/common';

export interface StreamSource extends BaseEntity {
  id: string;
  name: string;
  url: string;
  type: 'rtmp' | 'hls' | 'dash' | 'webrtc' | 'srt';
  protocol: string;
  credentials?: {
    username?: string;
    password?: string;
    token?: string;
  };
  backupUrls?: string[];
  isActive: boolean;
  priority: number;
  region?: string;
  cdnProvider?: string;
}

export interface StreamQuality extends BaseEntity {
  id: string;
  label: string;
  bitrate: number;
  resolution: {
    width: number;
    height: number;
  };
  framerate: number;
  codec: 'h264' | 'h265' | 'vp9' | 'av1';
  audioCodec: 'aac' | 'opus' | 'mp3';
  audioBitrate: number;
  isDefault: boolean;
  isTranscoding: boolean;
  segmentDuration?: number;
}

export interface StreamMetadata extends BaseEntity {
  id: string;
  streamKey: string;
  title: string;
  description?: string;
  category: string;
  tags: string[];
  language: string;
  isMature: boolean;
  thumbnailUrl?: string;
  previewUrl?: string;
  scheduledAt?: Date;
  startedAt?: Date;
  endedAt?: Date;
  status: 'idle' | 'starting' | 'live' | 'ending' | 'ended' | 'error';
  viewerCount: number;
  peakViewerCount: number;
  totalViews: number;
  duration: number;
  qualities: StreamQuality[];
  sources: StreamSource[];
  currentQuality?: string;
  recordingEnabled: boolean;
  recordingPath?: string;
  chatEnabled: boolean;
  chatMode: 'public' | 'subscribers' | 'followers' | 'emote-only';
  latencyMode: 'low' | 'normal' | 'high';
  drmEnabled: boolean;
  geoBlocking?: {
    allowedCountries?: string[];
    blockedCountries?: string[];
  };
  monetization: {
    donationsEnabled: boolean;
    subscriptionsEnabled: boolean;
    adsEnabled: boolean;
    sponsorshipEnabled: boolean;
  };
}

export interface StreamConfig extends BaseEntity {
  id: string;
  streamId: string;
  ingestUrl: string;
  streamKey: string;
  recommendedBitrate: number;
  maxBitrate: number;
  keyframeInterval: number;
  allowedResolutions: Array<{ width: number; height: number }>;
  allowedFramerates: number[];
  requiredAudioSampleRate: number;
  requiredAudioChannels: number;
  recording: {
    enabled: boolean;
    format: 'mp4' | 'flv' | 'ts' | 'mkv';
    path: string;
    maxDuration?: number;
    maxSize?: number;
    segmentDuration?: number;
  };
  transcoding: {
    enabled: boolean;
    profiles: Array<{
      name: string;
      bitrate: number;
      resolution: { width: number; height: number };
      framerate: number;
      codec: string;
    }>;
  };
  dvr: {
    enabled: boolean;
    windowDuration: number;
    storagePath: string;
  };
  latency: {
    target: number;
    mode: 'low' | 'normal' | 'high';
  };
  security: {
    tokenAuth: boolean;
    ipWhitelist?: string[];
    ipBlacklist?: string[];
    domainRestriction?: string[];
    geoRestriction?: {
      allowed?: string[];
      blocked?: string[];
    };
  };
}

export interface ViewerStats extends BaseEntity {
  streamId: string;
  timestamp: Date;
  currentViewers: number;
  uniqueViewers: number;
  peakViewers: number;
  averageWatchTime: number;
  totalWatchTime: number;
  viewersByQuality: Record<string, number>;
  viewersByRegion: Record<string, number>;
  viewersByDevice: Record<string, number>;
  viewersByPlatform: Record<string, number>;
  chatMessages: number;
  chatParticipants: number;
  donations: {
    count: number;
    totalAmount: number;
    currency: string;
  };
  subscriptions: {
    new: number;
    renewed: number;
    gifted: number;
  };
  adImpressions: number;
  adRevenue: number;
  bufferHealth: {
    average: number;
    p50: number;
    p95: number;
    p99: number;
  };
  errorRate: number;
  startupTime: {
    average: number;
    p50: number;
    p95: number;
  };
}

export interface ChatMessage extends BaseEntity {
  id: string;
  streamId: string;
  userId: string;
  username: string;
  displayName: string;
  userRole: 'viewer' | 'moderator' | 'vip' | 'subscriber' | 'broadcaster' | 'admin';
  userBadges: Array<{
    type: string;
    version: string;
    title: string;
  }>;
  message: string;
  formattedMessage: string;
  emotes: Array<{
    id: string;
    name: string;
    positions: Array<[number, number]>;
    urls: Record<string, string>;
  }>;
  mentions: Array<{
    userId: string;
    username: string;
  }>;
  replyTo?: {
    messageId: string;
    username: string;
    message: string;
  };
  isAction: boolean;
  isHighlighted: boolean;
  isPinned: boolean;
  deletedAt?: Date;
  deletedBy?: string;
  deletedReason?: string;
}

export interface DonationEvent extends BaseEntity {
  id: string;
  streamId: string;
  donorId: string;
  donorName: string;
  donorEmail?: string;
  amount: number;
  currency: string;
  formattedAmount: string;
  message?: string;
  isAnonymous: boolean;
  isTest: boolean;
  paymentProvider: 'stripe' | 'paypal' | 'streamlabs' | 'streamElements' | 'custom';
  transactionId: string;
  fee?: {
    amount: number;
    currency: string;
  };
  netAmount?: number;
  status: 'pending' | 'completed' | 'failed' | 'refunded' | 'cancelled';
  completedAt?: Date;
  refundedAt?: Date;
  refundReason?: string;
  metadata?: Record<string, unknown>;
}

export interface SubscriptionEvent extends BaseEntity {
  id: string;
  streamId: string;
  subscriberId: string;
  subscriberName: string;
  subscriberEmail?: string;
  tier: 'tier1' | 'tier2' | 'tier3' | 'prime';
  tierName: string;
  price: number;
  currency: string;
  isGift: boolean;
  gifterId?: string;
  gifterName?: string;
  giftMonths?: number;
  isRenewal: boolean;
  cumulativeMonths: number;
  streakMonths: number;
  paymentProvider: 'stripe' | 'paypal' | 'twitch' | 'youtube' | 'custom';
  transactionId: string;
  status: 'active' | 'cancelled' | 'expired' | 'paused' | 'payment_failed';
  startedAt: Date;
  currentPeriodEnd: Date;
  cancelledAt?: Date;
  cancelReason?: string;
  metadata?: Record<string, unknown>;
}

export interface StreamEvent extends BaseEntity {
  id: string;
  streamId: string;
  type: 'stream