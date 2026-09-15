import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
// A separate database holds an OS-backed exclusive lock for this host's lifetime.
// SQLite releases it on process death; recovery never deletes another owner's lock.
export function acquireRuntimeLock(file: string) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const lock = new DatabaseSync(file);
  try {
    chmodSync(file, 0o600);
    lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
  } catch (error) {
    lock.close();
    throw error;
  }
  let released = false;
  return () => {
    if (!released) {
      released = true;
      lock.close();
    }
  };
}
