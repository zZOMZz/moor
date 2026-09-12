import { api, type Identity } from './api';
import { firstStartupSource } from './bootstrap';
import * as cache from './cache';

// Fetch identity alongside the UI. Signing in never needs the session WASM runtime.
export async function start() {
  if (location.pathname === '/auth/google/complete') {
    const { showGoogleComplete } = await import('./ui');
    showGoogleComplete();
    window.dispatchEvent(new Event('moor:ready'));
    return;
  }
  const identity = api('/api/me').catch(() => null) as Promise<Identity | null>;
  const cachedOwner = cache.read<string>('last-owner').catch(() => undefined);
  const [source, { showAuth }] = await Promise.all([
    firstStartupSource(identity, cachedOwner),
    import('./ui'),
  ]);
  if (source.kind === 'identity' && source.identity && !source.identity.owner) {
    const me = source.identity;
    void cache.write('last-owner', undefined).catch(() => {});
    showAuth({
      setup: me.needsSetup,
      googleEnabled: me.google?.enabled,
      onSubmit: async (data) => {
        await api(me.needsSetup ? '/api/setup' : '/api/login', data);
        await start();
      },
    });
    window.dispatchEvent(new Event('moor:ready'));
    return;
  }
  const status = document.querySelector('#startup-status');
  if (status) status.textContent = '正在恢复工作区…';
  const app = await import('./app');
  await app.boot(identity, cachedOwner);
  if (
    'serviceWorker' in navigator &&
    !['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname)
  )
    void navigator.serviceWorker.register('/sw.js').catch(() => {});
}
