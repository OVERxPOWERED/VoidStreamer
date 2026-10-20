```javascript
const { z } = require('zod');
const InputSanitizationService = require('../services/input-sanitization-service');
const {
  StreamSource: StreamSourceType,
  StreamLink: StreamLinkType,
  SearchResult: SearchResultType,
  QualityOption: QualityOptionType,
  UserPreferences: UserPreferencesType,
  StreamQuality,
  StreamCategory,
  StreamLanguage
} = require('../types/common');

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

  static StreamCategory = {
    MOVIE: 'movie',
    TV_SHOW: 'tv_show',
    LIVE_TV: 'live_tv',
    SPORTS: 'sports',
    ANIME: 'anime',
    DOCUMENTARY: 'documentary',
    OTHER: 'other'
  };

  static StreamLanguage = {
    EN: 'en',
    ES: 'es',
    FR: 'fr',
    DE: 'de',
    IT: 'it',
    PT: 'pt',
    RU: 'ru',
    JA: 'ja',
    KO: 'ko',
    ZH: 'zh',
    AR: 'ar',
    HI: 'hi',
    MULTI: 'multi',
    UNKNOWN: 'unknown'
  };

  static ALLOWED_QUALITY_VALUES = Object.values(StreamDomain.StreamQuality);
  static ALLOWED_CATEGORY_VALUES = Object.values(StreamDomain.StreamCategory);
  static ALLOWED_LANGUAGE_VALUES = Object.values(StreamDomain.StreamLanguage);

  static StreamSourceSchema = z.object({
    id: z.string().min(1, 'StreamSource id is required'),
    name: z.string().min(1, 'StreamSource name is required'),
    baseUrl: z.string().url('StreamSource baseUrl must be a valid URL'),
    isActive: z.boolean(),
    priority: z.number().int().nonnegative('StreamSource priority must be a non-negative integer'),
    category: z.enum(StreamDomain.ALLOWED_CATEGORY_VALUES).optional(),
    languages: z.array(z.enum(StreamDomain.ALLOWED_LANGUAGE_VALUES)).optional(),
    rateLimit: z.number().int().positive().optional(),
    headers: z.record(z.string()).optional(),
    metadata: z.record(z.unknown()).optional()
  });

  static StreamLinkSchema = z.object({
    id: z.string().min(1, 'StreamLink id is required'),
    sourceId: z.string().min(1, 'StreamLink sourceId is required'),
    title: z.string().min(1, 'StreamLink title is required'),
    url: z.string().url('StreamLink url must be a valid URL'),
    quality: z.enum(StreamDomain.ALLOWED_QUALITY_VALUES),
    category: z.enum(StreamDomain.ALLOWED_CATEGORY_VALUES).optional(),
    language: z.enum(StreamDomain.ALLOWED_LANGUAGE_VALUES).optional(),
    subtitles: z.array(z.object({
      language: z.enum(StreamDomain.ALLOWED_LANGUAGE_VALUES),
      url: z.string().url(),
      format: z.enum(['vtt', 'srt', 'ass']).optional()
    })).optional(),
    headers: z.record(z.string()).optional(),
    expiresAt: z.date().optional(),
    bandwidth: z.number().int().positive().optional(),
    codec: z.string().optional(),
    isDirect: z.boolean().optional(),
    referer: z.string().url().optional()
  });

  static SearchResultSchema = z.object({
    id: z.string().min(1, 'SearchResult id is required'),
    title: z.string().min(1, 'SearchResult title is required'),
    originalTitle: z.string().optional(),
    year: z.number().int().min(1900).max(new Date().getFullYear() + 5).optional(),
    category: z.enum(StreamDomain.ALLOWED_CATEGORY_VALUES),
    poster: z.string().url().optional(),
    backdrop: z.string().url().optional(),
    overview: z.string().optional(),
    rating: z.number().min(0).max(10).optional(),
    voteCount: z.number().int().nonnegative().optional(),
    genres: z.array(z.string()).optional(),
    languages: z.array(z.enum(StreamDomain.ALLOWED_LANGUAGE_VALUES)).optional(),
    runtime: z.number().int().positive().optional(),
    seasons: z.number().int().positive().optional(),
    episodes: z.number().int().positive().optional(),
    status: z.enum(['ongoing', 'ended', 'upcoming', 'cancelled']).optional(),
    firstAirDate: z.date().optional(),
    lastAirDate: z.date().optional(),
    sourceId: z.string().min(1, 'SearchResult sourceId is required'),
    sourceName: z.string().min(1, 'SearchResult sourceName is required'),
    sourceUrl: z.string().url().optional(),
    metadata: z.record(z.unknown()).optional()
  });

  static QualityOptionSchema = z.object({
    quality: z.enum(StreamDomain.ALLOWED_QUALITY_VALUES),
    label: z.string().min(1, 'QualityOption label is required'),
    bandwidth: z.number().int().positive('QualityOption bandwidth must be positive'),
    resolution: z.string().regex(/^\d+x\d+$/, 'QualityOption resolution must be in format WIDTHxHEIGHT').optional(),
    codec: z.string().optional(),
    isDefault: z.boolean().optional()
  });

  static UserPreferencesSchema = z.object({
    userId: z.string().min(1, 'UserPreferences userId is required'),
    preferredQuality: z.enum(StreamDomain.ALLOWED_QUALITY_VALUES).optional(),
    preferredLanguage: z.enum(StreamDomain.ALLOWED_LANGUAGE_VALUES).optional(),
    preferredSubtitleLanguage: z.enum(StreamDomain.ALLOWED_LANGUAGE_VALUES).optional(),
    autoPlayNext: z.boolean().optional(),
    skipIntro: z.boolean().optional(),
    playbackSpeed: z.number().min(0.5).max(3).optional(),
    volume: z.number().min(0).max(1).optional(),
    theme: z.enum(['light', 'dark', 'system']).optional(),
    reducedMotion: z.boolean().optional(),
    dataSaver: z.boolean().optional(),
    favoriteSources: z.array(z.string()).optional(),
    blockedSources: z.array(z.string()).optional(),
    watchHistory: z.array(z.object({
      id: z.string(),
      title: z.string(),
      progress: z.number().min(0).max(1),
      timestamp: z.date(),
      sourceId: z.string()
    })).optional(),
    continueWatching: z.array(z.object({
      id: z.string(),
      title: z.string(),
      progress: