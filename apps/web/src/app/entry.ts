import { api, ApiError, type Identity } from '../platform/api';
import { firstStartupSource } from './bootstrap';

// Fetch identity alongside the UI. Signing in never needs the session WASM runtime.
export async function start() {
  if ((window as unknown as { moorWorkspace?: { version: number } }).moorWorkspace?.version === 1) {
    const { bootWorkspace } = await import('./workspace-app');
    await bootWorkspace();
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
  const { browserCachedOwner, forgetBrowserOwner } = await import('../platform/browser-storage');
  const identity = api('/api/me').catch((error) =>
    error instanceof ApiError && [401, 403].includes(error.status)
      ? { owner: null, needsSetup: false }
      : null,
  ) as Promise<Identity | null>;
  const cachedOwner = browserCachedOwner(location.origin).catch(() => undefined);
  const [source, { showAuth }] = await Promise.all([
    firstStartupSource(identity, cachedOwner),
    import('../components/ui'),
  ]);
  if (source.kind === 'identity' && source.identity && !source.identity.owner) {
    const me = source.identity;
    void forgetBrowserOwner(location.origin).catch(() => {});
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
  const { bootBrowserWorkspace } = await import('./browser-workspace-app');
  await bootBrowserWorkspace(identity, cachedOwner);
  window.dispatchEvent(new Event('moor:ready'));
  if (
    'serviceWorker' in navigator &&
    !['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname)
  )
    void navigator.serviceWorker.register('/sw.js').catch(() => {});
}
