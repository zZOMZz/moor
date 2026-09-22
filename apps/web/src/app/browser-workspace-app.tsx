import { createRoot } from 'react-dom/client';
import { z } from 'zod';
import { id } from '@moor/protocol/protocol';
import { desktopWorkspaceTargetSchema } from '@moor/client/workspace-protocol';
import { BrowserHttpError, createBrowserWorkspaceHttp } from '@moor/client/browser-http';
import {
  accountManagementPlan,
  validateAccountManagementResult,
} from '@moor/protocol/account-management';
import { WorkspaceApp } from './workspace-app';
import { WorkspaceController } from '../features/workspace/workspace-controller';
import { WorkspaceStore } from '../features/workspace/workspace-store';
import { BrowserWorkspaceRuntime } from '../platform/browser-workspace';
import { forgetBrowserOwner, rememberBrowserOwner } from '../platform/browser-storage';
import { api, ApiError, type Identity } from '../platform/api';
import type { AccountApi } from '../platform/account';
import { logoutBrowserAccount } from '../platform/browser-logout';
import { firstStartupSource } from './bootstrap';
import { BrowserAccountControls } from '../features/auth/browser-account';
import { reconcileNotificationAccount } from '../features/notifications/notification-browser';
import { parseNotificationNavigation } from '../features/notifications/notification-navigation';

const selectionSchema = z.object({
  scope: z.object({
    source: z.literal('remote'),
    target: desktopWorkspaceTargetSchema.omit({ sessionId: true }),
  }),
  sessionId: id,
});
const changedSchema = z.object({
  type: z.literal('changed'),
  deviceId: id,
  workspaceId: id.optional(),
  room: z.object({ scope: z.string(), docId: id.optional() }).optional(),
});

export async function bootBrowserWorkspace(
  identity: Promise<Identity | null>,
  cachedOwner: Promise<string | undefined>,
) {
  const source = await firstStartupSource(identity, cachedOwner);
  if (source.kind === 'identity' && source.identity && !source.identity.owner) {
    await forgetBrowserOwner(location.origin).catch(() => {});
    const { showAuth } = await import('../components/ui');
    showAuth({
      setup: source.identity.needsSetup,
      googleEnabled: source.identity.google?.enabled,
      onSubmit: async (data) => {
        await api(source.identity!.needsSetup ? '/api/setup' : '/api/login', data);
        location.reload();
      },
    });
    return;
  }
  const owner =
    source.kind === 'cache' ? source.owner : (source.identity?.owner ?? (await cachedOwner));
  if (!owner) {
    const { showAuth } = await import('../components/ui');
    showAuth({
      setup: false,
      onSubmit: async (data) => {
        await api('/api/login', data);
        location.reload();
      },
    });
    return;
  }
  const store = new WorkspaceStore();
  const runtime = new BrowserWorkspaceRuntime({
    origin: location.origin,
    owner,
    store,
    initialCache: true,
  });
  const controller = new WorkspaceController({
    store,
    request: (request) => runtime.request(request),
    restoreLegacy: (...args) => runtime.restoreLegacy(...args),
  });
  const { disposeUI } = await import('../components/ui');
  disposeUI();
  const root = createRoot(document.getElementById('app')!);
  let closed = false,
    socket: WebSocket | undefined,
    retry: ReturnType<typeof setTimeout> | undefined,
    attempt = 0;
  const listeners = new Set<(notice: unknown) => void>();
  const notify = (value: object) => {
    if (closed) return;
    const notice = { source: 'remote', owner, connectionId: runtime.client.connectionId, ...value };
    for (const listener of listeners) listener(notice);
  };
  const connect = () => {
    if (closed || socket) return;
    const url = new URL('/events', location.origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const candidate = new WebSocket(url);
    socket = candidate;
    candidate.onopen = () => {
      if (candidate === socket) {
        attempt = 0;
        notify({ kind: 'connected' });
      }
    };
    candidate.onmessage = (event) => {
      if (candidate !== socket || typeof event.data !== 'string' || event.data.length > 4096)
        return;
      try {
        const notice = changedSchema.parse(JSON.parse(event.data));
        if (notice.room && notice.room.scope !== 'doc') return;
        notify({
          kind: 'changed',
          deviceId: notice.deviceId,
          ...(notice.workspaceId ? { workspaceId: notice.workspaceId } : {}),
          ...(notice.room?.docId ? { sessionId: notice.room.docId } : {}),
        });
      } catch {
        /* Invalidation never supplies a document or an operation. */
      }
    };
    candidate.onerror = () => candidate.close();
    candidate.onclose = () => {
      if (candidate !== socket) return;
      socket = undefined;
      notify({ kind: 'disconnected' });
      if (!closed) retry = setTimeout(connect, Math.min(30000, 1000 * 2 ** attempt++));
    };
  };
  const accountIdentity = async () => {
    const value = (await api('/api/me').catch((error) => {
      if (error instanceof ApiError && [401, 403].includes(error.status))
        return { owner: null, needsSetup: false };
      throw error;
    })) as Identity;
    if (value.owner !== owner) {
      await switchIdentity(value);
      throw Error('账号已改变。');
    }
    return value;
  };
  const accountApi: AccountApi = async (request) => {
    try {
      if (request.action === 'logout') {
        await logoutBrowserAccount({
          owner: request.owner,
          origin: location.origin,
          identity: accountIdentity,
          current: () => {
            if (closed) throw Error('账号页面已失效。');
          },
        });
        await forgetBrowserOwner(location.origin);
        await reconcileNotificationAccount().catch(() => {});
        return { ok: true, value: { loggedOut: true } };
      }
      const value = await accountIdentity();
      if (request.action !== 'status') {
        const plan = accountManagementPlan(request);
        if (plan.request.owner !== value.owner) throw Error('账号已改变，请重新读取后操作。');
        const http = createBrowserWorkspaceHttp(
          { origin: location.origin },
          {
            signal: AbortSignal.timeout(30000),
            current: () => {
              if (closed) throw Error('账号页面已失效。');
            },
          },
        );
        const raw = await http.json(plan.path, plan.body, plan.responseBytes);
        const after = await accountIdentity();
        if (
          after.owner !== value.owner ||
          after.actor?.authorityId !== value.actor?.authorityId ||
          after.actor?.kind !== value.actor?.kind
        )
          throw Error('账号授权已改变，原操作结果需要核查。');
        const result = validateAccountManagementResult(plan.request, raw);
        return { ok: true, value: result };
      }
      return {
        ok: true,
        value: {
          origin: location.origin,
          owner: value.owner,
          needsSetup: value.needsSetup,
          google: { enabled: value.google?.enabled ?? false },
        },
      };
    } catch (error) {
      if (error instanceof BrowserHttpError && [401, 403].includes(error.status))
        await accountIdentity().catch(() => {});
      return {
        ok: false,
        error: { message: error instanceof Error ? error.message : '账号状态无法读取。' },
      };
    }
  };
  const unsubscribe = controller.subscribe(() => {
    const state = controller.state;
    if (state.scope && state.sessionId)
      void runtime.saveSelection(state.scope, state.sessionId).catch(() => {});
  });
  function stop() {
    if (closed) return;
    closed = true;
    clearTimeout(retry);
    const previous = socket;
    socket = undefined;
    previous?.close();
    unsubscribe();
    root.unmount();
    runtime.close();
    void controller.flushDraft().finally(() => controller.close());
  }
  async function switchIdentity(value: Identity) {
    if (closed) return;
    stop();
    await rememberBrowserOwner(location.origin, value.owner ?? '').catch(() => {});
    await bootBrowserWorkspace(Promise.resolve(value), Promise.resolve(undefined));
  }
  root.render(
    <WorkspaceApp
      controller={controller}
      accountApi={accountApi}
      localAvailable={false}
      accountExtras={<BrowserAccountControls owner={owner} identity={accountIdentity} />}
      subscribeSessionChanges={(listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      }}
    />,
  );
  const restoring = (async () => {
    await controller.refreshCatalog('remote');
    const saved = selectionSchema.safeParse(await runtime.selection());
    if (saved.success && !closed) {
      await controller.selectProject('remote', saved.data.scope.target);
      await controller.openSession(saved.data.sessionId).catch(() => {});
    }
  })().catch(() => {});
  void identity.then(async (me) => {
    if (closed) return;
    if (me && me.owner !== owner) {
      await switchIdentity(me);
      return;
    }
    if (!me?.owner) return;
    await restoring;
    if (closed) return;
    await controller.refreshCatalog('remote').catch(() => {});
    if (controller.state.sessionId) {
      await controller.refreshSessions().catch(() => {});
      await controller.refreshSession().catch(() => {});
    }
    if (!me.localOnly) await reconcileNotificationAccount(owner).catch(() => {});
    connect();
    const url = new URL(location.href),
      raw = url.searchParams.get('notification');
    if (raw && runtime.authenticated) {
      url.searchParams.delete('notification');
      history.replaceState(history.state, '', url.pathname + url.search + url.hash);
      try {
        const event = parseNotificationNavigation(raw, owner, me.localOnly === true, Date.now());
        const targets =
          controller.state.catalogs.remote?.targets.filter(
            ({ target }) =>
              target.userId === event.userId &&
              target.machineId === event.machineId &&
              target.workspaceId === event.workspaceId &&
              target.localProjectId === event.localProjectId &&
              (!('deviceId' in event) || target.deviceId === event.deviceId),
          ) ?? [];
        if (targets.length !== 1) return;
        await controller.selectProject('remote', targets[0]!.target);
        await controller.openSession(event.sessionId, event.turnId);
      } catch {
        /* Navigation cannot authorize or replay a request. */
      }
    }
  });
  window.addEventListener('pagehide', stop, { once: true });
}
