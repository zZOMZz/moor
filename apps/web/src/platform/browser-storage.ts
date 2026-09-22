import { productCanonicalJson as canonical } from '@moor/protocol/canonical-json';
import { IndexedStorage } from './indexed-storage';
import { readLegacyWebRecord } from './retired-records';
export const browserOwnerKey = (origin: string) => canonical(['moor-browser-owner-v1', origin]);
export async function browserCachedOwner(origin: string): Promise<string | undefined> {
  const storage = new IndexedStorage({ databaseName: 'moor-desktop-workspace-v1' });
  try {
    const value = await storage.read(browserOwnerKey(origin));
    if (typeof value === 'string') return value || undefined;
    return readLegacyWebRecord<string>('last-owner');
  } finally {
    storage.close();
  }
}
export async function forgetBrowserOwner(origin: string) {
  return rememberBrowserOwner(origin, '');
}
export async function rememberBrowserOwner(origin: string, owner: string) {
  if (typeof owner !== 'string' || owner.length > 1000) throw Error('账号选择无效。');
  const storage = new IndexedStorage({ databaseName: 'moor-desktop-workspace-v1' });
  const key = browserOwnerKey(origin),
    current = () => {};
  try {
    await storage.exclusive(key, current, async () => {
      const before = await storage.read(key);
      await storage.compareAndSet(key, before, owner, current);
    });
  } finally {
    storage.close();
  }
}
