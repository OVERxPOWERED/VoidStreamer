import { BaseEntity } from '../types/common.d.ts';

export enum StreamQuality {
  SD = 'SD',
  HD = 'HD',
  FHD = 'FHD',
  UHD = 'UHD'
}

export interface StreamSource extends BaseEntity {
  id: string;
  name: string;
  url: string;
  isActive: boolean;
  priority: number;
}

export interface StreamMetadata extends BaseEntity {
  title: string;
  description: string;
  thumbnailUrl: string;
  duration: number;
  quality: StreamQuality;
  sourceId: string;
}

export interface StreamSearchParams {
  query?: string;
  quality?: StreamQuality;
  sourceIds?: string[];
  page?: number;
  limit?: number;
}

export interface StreamService {
  searchStreams(params: StreamSearchParams): Promise<StreamMetadata[]>;
  getStreamUrl(sourceId: string, quality: StreamQuality): Promise<string>;
  validateSource(sourceId: string): Promise<boolean>;
}