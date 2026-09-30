import { BaseEntity, Nullable } from './common.d.ts';

export enum StreamPlatform {
  TWITCH = 'TWITCH',
  YOUTUBE = 'YOUTUBE',
  KICK = 'KICK',
  TROVO = 'TROVO'
}

export type StreamQuality = '1080p' | '720p' | '480p' | '360p' | 'audio_only';

export interface StreamEntity extends BaseEntity {
  id: string;
  title: string;
  url: string;
  thumbnailUrl: Nullable<string>;
  isLive: boolean;
  viewerCount: number;
  category: Nullable<string>;
  startedAt: Nullable<Date>;
  platform: StreamPlatform;
  quality: StreamQuality[];
}

export interface StreamFilters {
  platform?: StreamPlatform;
  category?: string;
  isLive?: boolean;
  minViewers?: number;
  maxViewers?: number;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}