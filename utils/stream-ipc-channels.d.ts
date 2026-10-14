import type { StreamSearchParams, StreamMetadata, StreamQuality } from '../domain/stream-domain.d.ts';

export enum IPC_CHANNELS {
  STREAM_SEARCH = 'stream:search',
  STREAM_GET_URL = 'stream:get-url',
  STREAM_VALIDATE_SOURCE = 'stream:validate-source',
  STREAM_HEALTH_CHECK = 'stream:health-check',
}

export interface StreamSearchRequest extends StreamSearchParams {
  requestId: string;
}

export interface StreamSearchResponse {
  requestId: string;
  results: StreamMetadata[];
  totalResults: number;
  searchDurationMs: number;
}

export interface StreamUrlRequest {
  requestId: string;
  sourceId: string;
  quality: StreamQuality;
}

export interface StreamUrlResponse {
  requestId: string;
  url: string;
  expiresAt: number;
  headers?: Record<string, string>;
}

export interface StreamValidateRequest {
  requestId: string;
  sourceId: string;
}

export interface StreamValidateResponse {
  requestId: string;
  isValid: boolean;
  error?: string;
}

export interface StreamHealthResponse {
  sourceId: string;
  isHealthy: boolean;
  latencyMs: number;
  lastChecked: number;
  error?: string;
}
