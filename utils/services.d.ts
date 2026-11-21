import { BaseEntity } from './common.d.ts';

export interface StreamerProfile extends BaseEntity {
  id: string;
  username: string;
  platform: string;
  status: 'online' | 'offline' | 'away' | 'busy';
  metadata: Record<string, unknown>;
}

export interface StreamSession extends BaseEntity {
  id: string;
  streamerId: string;
  startTime: Date;
  endTime: Date | null;
  viewerCount: number;
  category: string;
}

export interface IStreamerService {
  getStreamer(id: string): Promise<StreamerProfile | null>;
  searchStreamers(query: string): Promise<StreamerProfile[]>;
  createSession(streamerId: string): Promise<StreamSession>;
  endSession(sessionId: string): Promise<StreamSession>;
  getSessionStats(sessionId: string): Promise<SessionStats>;
}

export interface SessionStats {
  sessionId: string;
  totalViewers: number;
  peakViewers: number;
  averageViewers: number;
  durationMinutes: number;
  category: string;
}