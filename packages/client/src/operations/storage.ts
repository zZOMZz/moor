export type StorageBackend = {
  read(key: string): Promise<unknown>;
  exclusive<T>(key: string, current: () => void, task: () => Promise<T>): Promise<T>;
  compareAndSet(key: string, expected: unknown, value: unknown, current: () => void): Promise<void>;
  /** Comparisons, writes and explicit deletions commit together, or none do. */
  compareAndSetMany?(changes: StorageChange[], current: () => void): Promise<void>;
  close?(): void;
};

export type StorageChange =
  | { key: string; expected: unknown; value: unknown; delete?: never }
  | { key: string; expected: unknown; delete: true; value?: never };
