import { BaseEntity } from './common.d.ts';

export interface Stream extends BaseEntity {
  id: string;
  title: string;
  url: string;
  thumbnailUrl: string;
  channelId: string;
  categoryId: string;
  isLive: boolean;
  viewerCount: number;
  startedAt: Date | string;
  status: StreamStatus;
}

export interface Channel extends BaseEntity {
  id: string;
  name: string;
  handle: string;
  avatarUrl: string;
  subscriberCount: number;
  verified: boolean;
}

export interface Category extends BaseEntity {
  id: string;
  name: string;
  slug: string;
  description: string;
}

export type StreamStatus = 'live' | 'offline' | 'scheduled';

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}

export interface StreamFilters {
  status?: StreamStatus;
  categoryId?: string;
  channelId?: string;
  search?: string;
  sortBy?: 'viewerCount' | 'startedAt' | 'title';
  sortOrder?: 'asc' | 'desc';
}

export interface ChannelFilters {
  verified?: boolean;
  search?: string;
  sortBy?: 'subscriberCount' | 'name' | 'createdAt';
  sortOrder?: 'asc' | 'desc';
}