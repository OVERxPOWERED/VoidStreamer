import { StreamQuality } from './stream-quality';

export interface StreamSchedule {
  id: string;
  streamUrl: string;
  cronExpression?: string;
  startTime?: Date | string;
  duration: number;
  quality: StreamQuality;
  outputPath: string;
  enabled: boolean;
  createdAt: Date | string;
  updatedAt: Date | string;
  lastRunAt?: Date | string;
  nextRunAt?: Date | string;
  runCount: number;
  maxRuns?: number;
  metadata?: Record<string, unknown>;
}

export enum ScheduleStatus {
  Pending = 'pending',
  Running = 'running',
  Completed = 'completed',
  Failed = 'failed',
  Disabled = 'disabled',
}

export interface ScheduleExecution {
  scheduleId: string;
  status: ScheduleStatus;
  startedAt: Date | string;
  completedAt?: Date | string;
  duration?: number;
  outputFile?: string;
  error?: string;
  bytesRecorded?: number;
}

export type SchedulerEvents = {
  'schedule:created': (schedule: StreamSchedule) => void;
  'schedule:triggered': (schedule: StreamSchedule, execution: ScheduleExecution) => void;
  'schedule:completed': (schedule: StreamSchedule, execution: ScheduleExecution) => void;
  'schedule:failed': (schedule: StreamSchedule, execution: ScheduleExecution, error: Error) => void;
  'schedule:disabled': (scheduleId: string) => void;
  'schedule:enabled': (scheduleId: string) => void;
  'schedule:deleted': (scheduleId: string) => void;
};

export interface SchedulePersistenceSchema {
  version: number;
  schedules: StreamSchedule[];
  executions: ScheduleExecution[];
  exportedAt: Date | string;
}

export interface CreateScheduleInput {
  streamUrl: string;
  cronExpression?: string;
  startTime?: Date | string;
  duration: number;
  quality: StreamQuality;
  outputPath: string;
  enabled?: boolean;
  maxRuns?: number;
  metadata?: Record<string, unknown>;
}

export interface UpdateScheduleInput {
  streamUrl?: string;
  cronExpression?: string | null;
  startTime?: Date | string | null;
  duration?: number;
  quality?: StreamQuality;
  outputPath?: string;
  enabled?: boolean;
  maxRuns?: number | null;
  metadata?: Record<string, unknown>;
}

export type ScheduleType = 'recurring' | 'one-time';

export function getScheduleType(schedule: StreamSchedule): ScheduleType;