export type Nullable<T> = T | null | undefined;
export type AsyncResult<T> = Promise<{ data?: T; error?: Error }>;
export interface BaseEntity {
  id: string | number;
  createdAt: Date;
  updatedAt: Date;
}