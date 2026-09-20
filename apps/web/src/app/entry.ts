import { api, type Identity } from '../platform/api';
import { firstStartupSource } from './bootstrap';

// Fetch identity alongside the UI. Signing in never needs the session WASM runtime.
export async function start() {
  if ((window as unknown as { moorSecure?: { version: number } }).moorSecure?.version === 1) {
    if (
      (window as unknown as { moorWorkspace?: { version: number } }).moorWorkspace?.version === 1
    ) {
      const { bootWorkspace } = await import('./workspace-app');
      await bootWorkspace();
      window.dispatchEvent(new Event('moor:ready'));
      return;
    }
    const { bootSecure } = await import('./secure-app');
    await bootSecure();
    window.dispatchEvent(new Event('moor:ready'));
    return;
  }
  if (location.pathname === '/auth/google/complete') {
    const { showGoogleComplete } = await import('../components/ui');
    showGoogleComplete();
    window.dispatchEvent(new Event('moor:ready'));
    return;
  }
  const invitation = new URLSearchParams(location.search).get('invite');
  if (invitation) {
    const { showAuth } = await import('../components/ui');
    showAuth({
      setup: true,
      invited: true,
      onSubmit: async (data) => {
        await api('/api/account-invitations/redeem', { invitation, ...data });
        history.replaceState(null, '', '/');
        await start();
      },
    });
    window.dispatchEvent(new Event('moor:ready'));
    return;
  }
  const cache = await import('../platform/cache');
  const identity = api('/api/me').catch(() => null) as Promise<Identity | null>;
  const cachedOwner = cache.read<string>('last-owner').catch(() => undefined);
  const [source, { showAuth }] = await Promise.all([
    firstStartupSource(identity, cachedOwner),
    import('../components/ui'),
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
  if (new URLSearchParams(location.search).get('collaboration') === '1') {
    const owner = source.kind === 'cache' ? source.owner : source.identity?.owner;
    if (owner) {
      const { bootCollaboration } = await import('./collaboration-app');
      await bootCollaboration(owner, identity);
      window.dispatchEvent(new Event('moor:ready'));
      return;
    }
  }
  if (status) status.textContent = '正在恢复工作区…';
  const app = await import('./app');
  await app.boot(identity, cachedOwner);
  if (
    'serviceWorker' in navigator &&
    !['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname)
  )
    void navigator.serviceWorker.register('/sw.js').catch(() => {});
}
