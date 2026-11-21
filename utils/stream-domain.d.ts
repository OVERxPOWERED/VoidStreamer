// src/types/stream-domain.d.ts

export enum StreamSource {
  TWITCH = 'TWITCH',
  YOUTUBE = 'YOUTUBE',
  KICK = 'KICK',
  CUSTOM = 'CUSTOM',
}

export enum StreamQuality {
  SOURCE = 'SOURCE',
  HIGH = 'HIGH',
  MEDIUM = 'MEDIUM',
  LOW = 'LOW',
  AUDIO_ONLY = 'AUDIO_ONLY',
}

export interface StreamMetadata {
  viewerCount: number;
  category: string | null;
  tags: string[];
  thumbnailUrl: string | null;
  isLive: boolean;
  language: string | null;
  startedAt: string | null;
  streamKey: string | null;
}

export interface Stream {
  id: string;
  title: string;
  url: string;
  source: StreamSource;
  quality: StreamQuality;
  metadata: StreamMetadata;
  createdAt: string;
  updatedAt: string;
}

export interface CreateStreamInput {
  title: string;
  url: string;
  source: StreamSource;
  quality?: StreamQuality;
  metadata?: Partial<StreamMetadata>;
}

export interface UpdateStreamInput {
  title?: string;
  url?: string;
  quality?: StreamQuality;
  metadata?: Partial<StreamMetadata>;
}

export interface StreamFilters {
  source?: StreamSource;
  quality?: StreamQuality;
  isLive?: boolean;
  category?: string;
  tags?: string[];
  search?: string;
  limit?: number;
  offset?: number;
  sortBy?: 'createdAt' | 'updatedAt' | 'viewerCount' | 'title';
  sortOrder?: 'asc' | 'desc';
}

export interface StreamListResponse {
  streams: Stream[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export type StreamSourceValue = `${StreamSource}`;
export type StreamQualityValue = `${StreamQuality}`;

export interface JsonSchema {
  type: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: (string | number)[];
  format?: string;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  items?: JsonSchema;
  additionalProperties?: boolean | JsonSchema;
  description?: string;
  examples?: unknown[];
}

declare const StreamSourceSchema: JsonSchema;
declare const StreamQualitySchema: JsonSchema;
declare const StreamMetadataSchema: JsonSchema;
declare const StreamSchema: JsonSchema;
declare const CreateStreamInputSchema: JsonSchema;
declare const UpdateStreamInputSchema: JsonSchema;
declare const StreamFiltersSchema: JsonSchema;
declare const StreamListResponseSchema: JsonSchema;

export {
  StreamSourceSchema,
  StreamQualitySchema,
  StreamMetadataSchema,
  StreamSchema,
  CreateStreamInputSchema,
  UpdateStreamInputSchema,
  StreamFiltersSchema,
  StreamListResponseSchema,
};

export const StreamSchemas = {
  StreamSource: StreamSourceSchema,
  StreamQuality: StreamQualitySchema,
  StreamMetadata: StreamMetadataSchema,
  Stream: StreamSchema,
  CreateStreamInput: CreateStreamInputSchema,
  UpdateStreamInput: UpdateStreamInputSchema,
  StreamFilters: StreamFiltersSchema,
  StreamListResponse: StreamListResponseSchema,
} as const;

export type StreamSchemaKey = keyof typeof StreamSchemas;