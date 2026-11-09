/**
 * Stream Quality and Recording Type Definitions
 * 
 * Provides type contracts for stream quality selection, adaptive bitrate options,
 * and recording configuration to enable DVR and quality switching features.
 * 
 * @module types/stream-quality
 * @version 1.0.0
 */

import type { StreamSource } from './common.js';
import type { StreamPlatform } from './stream-domain.js';

/**
 * Supported video codecs for stream qualities
 */
export type VideoCodec = 'h264' | 'h265' | 'vp8' | 'vp9' | 'av1' | 'unknown';

/**
 * Supported audio codecs for stream qualities
 */
export type AudioCodec = 'aac' | 'mp3' | 'opus' | 'vorbis' | 'unknown';

/**
 * Supported container formats for recording
 */
export type RecordingFormat = 'mp4' | 'mkv' | 'ts' | 'flv' | 'webm';

/**
 * Stream resolution identifiers
 */
export type Resolution = 
  | '4320p'  // 8K
  | '2160p'  // 4K
  | '1440p'  // 2K/QHD
  | '1080p'  // Full HD
  | '720p'   // HD
  | '480p'   // SD
  | '360p'   // Low
  | '240p'   // Very Low
  | '144p'   // Minimum
  | 'audio_only'
  | 'unknown';

/**
 * Represents a single stream quality option with its technical specifications
 */
export interface StreamQuality {
  /** Unique identifier for this quality level */
  id: string;
  
  /** Source platform this quality belongs to */
  source: StreamSource;
  
  /** Human-readable quality label (e.g., "1080p60", "720p", "Audio Only") */
  label: string;
  
  /** Video resolution */
  resolution: Resolution;
  
  /** Video bitrate in bits per second */
  videoBitrate: number;
  
  /** Audio bitrate in bits per second */
  audioBitrate: number;
  
  /** Combined bitrate (video + audio) in bits per second */
  totalBitrate: number;
  
  /** Video codec used */
  videoCodec: VideoCodec;
  
  /** Audio codec used */
  audioCodec: AudioCodec;
  
  /** Frame rate (frames per second) */
  frameRate?: number;
  
  /** Direct stream URL (may be signed/expire) */
  url: string;
  
  /** Whether this quality is currently available */
  isAvailable: boolean;
  
  /** MIME type of the stream */
  mimeType?: string;
  
  /** HLS/DASH manifest URL if applicable */
  manifestUrl?: string;
  
  /** DRM protection info if applicable */
  drm?: {
    type: 'widevine' | 'playready' | 'fairplay' | 'clearkey';
    licenseUrl?: string;
    certificateUrl?: string;
  };
  
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Options for automatic quality selection logic
 */
export interface QualitySelectionOptions {
  /** Preferred resolution (will select closest match) */
  preferredResolution?: Resolution;
  
  /** Maximum allowed bitrate in bits per second */
  maxBitrate?: number;
  
  /** Minimum allowed bitrate in bits per second */
  minBitrate?: number;
  
  /** Enable adaptive bitrate streaming */
  adaptive: boolean;
  
  /** Preferred video codec (will prioritize matching codecs) */
  preferredVideoCodec?: VideoCodec;
  
  /** Preferred audio codec */
  preferredAudioCodec?: AudioCodec;
  
  /** Maximum frame rate */
  maxFrameRate?: number;
  
  /** Allow fallback to lower quality if preferred unavailable */
  allowFallback: boolean;
  
  /** Prefer hardware-decodable codecs */
  preferHardwareDecoding: boolean;
  
  /** Custom quality scoring function */
  customScorer?: (quality: StreamQuality) => number;
}

/**
 * Configuration options for stream recording
 */
export interface RecordingOptions {
  /** Output container format */
  format: RecordingFormat;
  
  /** Segment duration in seconds (for segmented formats) */
  segmentDuration: number;
  
  /** Maximum recording duration in seconds (0 = unlimited) */
  maxDuration: number;
  
  /** Output file/directory path */
  outputPath: string;
  
  /** File naming pattern (supports {timestamp}, {title}, {quality}, {platform}) */
  fileNamePattern?: string;
  
  /** Whether to record all available qualities simultaneously */
  recordAllQualities: boolean;
  
  /** Specific quality IDs to record (if not recording all) */
  qualityIds?: string[];
  
  /** Enable real-time transcoding during recording */
  transcode?: {
    /** Target video codec */
    videoCodec?: VideoCodec;
    /** Target video bitrate */
    videoBitrate?: number;
    /** Target resolution */
    resolution?: Resolution;
    /** Target audio codec */
    audioCodec?: AudioCodec;
    /** Target audio bitrate */
    audioBitrate?: number;
    /** FFmpeg preset */
    preset?: 'ultrafast' | 'superfast' | 'veryfast' | 'faster' | 'fast' | 'medium' | 'slow' | 'slower' | 'veryslow';
  };
  
  /** Segment retention policy */
  retention?: {
    /** Maximum number of segments to keep */
    maxSegments?: number;
    /** Maximum age in seconds */
    maxAge?: number;
    /** Delete segments after recording completes */
    deleteOnComplete?: boolean;
  };
  
  /** Metadata to embed in recording */
  metadata?: RecordingMetadata;
  
  /** Callback for recording progress updates */
  onProgress?: (progress: RecordingProgress) => void;
  
  /** Callback for recording errors */
  onError?: (error: Error) => void;
  
  /** Callback when recording completes */
  onComplete?: (result: RecordingResult) => void;
}

/**
 * Metadata to embed in recorded files
 */
export interface RecordingMetadata {
  /** Stream title */
  title: string;
  
  /** Streamer/channel name */
  streamer?: string;
  
  /** Platform the stream originated from */
  platform: StreamPlatform;
  
  /** Original stream URL */
  sourceUrl: string;
  
  /** Recording start timestamp (ISO 8601) */
  recordedAt: string;
  
  /** Quality ID that was recorded */
  qualityId: string;
  
  /** Resolution of recorded stream */
  resolution: Resolution;
  
  /** Bitrate of recorded stream */
  bitrate: number;
  
  /** Video codec used */
  videoCodec: VideoCodec;
  
  /** Audio codec used */
  audioCodec: AudioCodec;
  
  /** Custom tags */
  tags?: string[];
  
  /** Category/game being streamed */
  category?: string;
  
  /** Language of the stream */
  language?: string;
  
  /** Whether the stream was live at recording time */
  wasLive: boolean;
  
  /** Custom key-value metadata */
  custom?: Record<string, string>;
}

/**
 * Recording progress information
 */
export interface RecordingProgress {
  /** Current recording duration in seconds */
  currentDuration: number;
  
  /** Total expected duration in seconds (if known) */
  totalDuration?: number;
  
  /** Current file size in bytes */
  fileSize: number;
  
  /** Current bitrate in bits per second */
  currentBitrate: number;
  
  /** Number of segments written */
  segmentsWritten: number;
  
  /** Recording status */
  status: 'starting' | 'recording' | 'paused' | 'finalizing' | 'completed' | 'failed';
  
  /** Estimated time remaining in seconds */
  estimatedTimeRemaining?: number;
  
  /** Current download speed in bytes/second */
  downloadSpeed?: number;
}

/**
 * Result of a completed recording
 */
export interface RecordingResult {
  /** Whether recording completed successfully */
  success: boolean;
  
  /** Output file path(s) */
  outputPaths: string[];
  
  /** Total recording duration in seconds */
  duration: number;
  
  /** Total file size in bytes */
  totalSize: number;
  
  /** Average bitrate in bits per second */
  averageBitrate: number;
  
  /** Number of segments recorded */
  segmentCount: number;
  
  /** Any errors that occurred (non-fatal) */
  warnings?: string[];
  
  /** Error if recording failed */
  error?: Error;
  
  /** Recording metadata */
  metadata: RecordingMetadata;
  
  /** Start timestamp */
  startedAt: Date;
  
  /** End timestamp */
  endedAt: Date;
}

/**
 * Complete stream metadata including all available qualities
 */
export interface StreamMetadata {
  /** Unique stream identifier */
  id: string;
  
  /** Stream title */
  title: string;
  
  /** Streamer/channel name */
  streamer: string;
  
  /** Platform the stream is on */
  platform: StreamPlatform;
  
  /** Stream URL */
  url: string;
  
  /** Thumbnail image URL */
  thumbnail?: string;
  
  /** Whether the stream is currently live */
  isLive: boolean;
  
  /** Stream category/game */
  category?: string;
  
  /** Stream tags */
  tags?: string[];
  
  /** Stream language */
  language?: string;
  
  /** Viewer count (if live) */
  viewerCount?: number;
  
  /** Stream start time (if live) */
  startedAt?: Date;
  
  /** All available quality options */
  qualities: StreamQuality[];
  
  /** Default/recommended quality ID */
  defaultQualityId?: string;
  
  /** Whether stream is age-restricted */
  isMature?: boolean;
  
  /** Whether stream has DRM protection */
  hasDrm?: boolean;
  
  /** Stream description */
  description?: string;
  
  /** Additional platform-specific metadata */
  platformData?: Record<string, unknown>;
  
  /** Metadata fetch timestamp */
  fetchedAt: Date;
}

/**
 * Quality selection result with reasoning
 */
export interface QualitySelectionResult {
  /** Selected quality */
  quality: StreamQuality;
  
  /** Reason for selection */
  reason: 'exact_match' | 'closest_match' | 'fallback' | 'adaptive' | 'user_preference' | 'highest_available' | 'lowest_available';
  
  /** Alternative qualities that were considered */
  alternatives: StreamQuality[];
  
  /** Selection score (higher = better match) */
  score: number;
}

/**
 * Adaptive bitrate streaming configuration
 */
export interface AdaptiveBitrateConfig {
  /** Enable ABR */
  enabled: boolean;
  
  /** Initial quality to start with */
  initialQuality?: 'auto' | 'highest' | 'lowest' | string;
  
  /** Minimum buffer length in seconds before switching up */
  minBufferLength: number;
  
  /** Maximum buffer length in seconds */
  maxBufferLength: number;
  
  /** Bandwidth estimation window in seconds */
  bandwidthWindow: number;
  
  /** Switch up threshold (bandwidth / bitrate ratio) */
  switchUpThreshold: number;
  
  /** Switch down threshold (bandwidth / bitrate ratio) */
  switchDownThreshold: number;
  
  /** Minimum time between quality switches in seconds */
  minSwitchInterval: number;
  
  /** Custom bandwidth estimator */
  bandwidthEstimator?: 'default' | 'ewma' | 'harmonic' | ((samples: number[]) => number);
  
  /** Callback when quality changes */
  onQualityChange?: (newQuality: StreamQuality, reason: string) => void;
}

/**
 * Stream quality manifest for HLS/DASH
 */
export interface QualityManifest {
  /** Manifest format */
  format: 'hls' | 'dash';
  
  /** Manifest URL */
  url: string;
  
  /** Parsed quality levels */
  qualities: StreamQuality[];
  
  /** Master playlist content (raw) */
  rawContent?: string;
  
  /** Manifest fetch timestamp */
  fetchedAt: Date;
  
  /** Manifest expiry timestamp (if known) */
  expiresAt?: Date;
}

/**
 * Type guard to check if a resolution is video (not audio-only)
 */
export function isVideoResolution(resolution: Resolution): boolean {
  return resolution !== 'audio_only' && resolution !== 'unknown';
}

/**
 * Type guard to check if a quality has video
 */
export function hasVideo(quality: StreamQuality): boolean {
  return isVideoResolution(quality.resolution) && quality.videoBitrate > 0;
}

/**
 * Type guard to check if a quality is audio-only
 */
export function isAudioOnly(quality: StreamQuality): boolean {
  return quality.resolution === 'audio_only' || (quality.videoBitrate === 0 && quality.audioBitrate > 0);
}

/**
 * Compare two resolutions by quality (higher = better)
 */
export function compareResolutions(a: Resolution, b: Resolution): number {
  const order: Resolution[] = [
    '4320p', '2160p', '1440p', '1080p', '720p', '480p', '360p', '240p', '144p', 'audio_only', 'unknown'
  ];
  const aIndex = order.indexOf(a);
  const bIndex = order.indexOf(b);
  if (aIndex === -1 && bIndex === -1) return 0;
  if (aIndex === -1) return 1;
  if (bIndex === -1) return -1;
  return bIndex - aIndex; // Higher index = lower quality
}

/**
 * Get total bitrate from quality
 */
export function getTotalBitrate(quality: StreamQuality): number {
  return quality.videoBitrate + quality.audioBitrate;
}

/**
 * Default quality selection options
 */
export const DEFAULT_QUALITY_SELECTION_OPTIONS: QualitySelectionOptions = {
  adaptive: true,
  allowFallback: true,
  preferHardwareDecoding: true,
};

/**
 * Default recording options
 */
export const DEFAULT_RECORDING_OPTIONS: Partial<RecordingOptions> = {
  format: 'mp4',
  segmentDuration: 10,
  maxDuration: 0,
  recordAllQualities: false,
  fileNamePattern: '{title}_{quality}_{timestamp}.{format}',
  retention: {
    maxSegments: 100,
    maxAge: 86400, // 24 hours
    deleteOnComplete: false,
  },
};

/**
 * Default adaptive bitrate config
 */
export const DEFAULT_ADAPTIVE_BITRATE_CONFIG: AdaptiveBitrateConfig = {
  enabled: true,
  initialQuality: 'auto',
  minBufferLength: 10,
  maxBufferLength: 60,
  bandwidthWindow: 5,
  switchUpThreshold: 1.5,
  switchDownThreshold: 0.8,
  minSwitchInterval: 5,
  bandwidthEstimator: 'ewma',
};