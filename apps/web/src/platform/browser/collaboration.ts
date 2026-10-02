import type { CollaborationPageAccess } from '@moor/client/features/collaboration/page';
import { api } from '../api';
import { z } from 'zod';
export function browserCollaborationAccess(input: {
  owner: string;
  workspace: string;
  replica: string;
  session: string;
}): CollaborationPageAccess {
  const route =
    '/api/collaboration/' +
    [input.workspace, input.replica, input.session].map(encodeURIComponent).join('/');
  const owner = input.owner;
  const bind = (path: string) => path + '?expectedAccount=' + encodeURIComponent(owner);
  return {
    owner,
    identity: () => api('/api/me'),
    read: () => api(bind(route + '/read')),
    sync: (value) => api(bind(route + '/sync'), value),
    offer: (value) => api(bind(route + '/offer'), value),
    enable: () => api(bind(route + '/enable'), {}),
    member: (accountId, role) => api(bind(route + '/member'), { accountId, role }),
    async invite() {
      const value = z
        .object({ invitation: z.string(), expiresAt: z.number() })
        .parse(await api(bind('/api/account-invitations'), {}));
      return location.origin + '/?invite=' + encodeURIComponent(value.invitation);
    },
  };
}
/** Event and reconnect ownership stays in the browser adapter. */
export function subscribeCollaborationRefresh(refresh: () => void) {
  let closed = false,
    socket: WebSocket | undefined,
    timer: ReturnType<typeof setTimeout> | undefined;
  const connect = () => {
    if (
      closed ||
      socket?.readyState === WebSocket.OPEN ||
      socket?.readyState === WebSocket.CONNECTING
    )
      return;
    socket = new WebSocket(location.origin.replace(/^http/, 'ws') + '/events');
    socket.onopen = refresh;
    socket.onmessage = refresh;
    socket.onclose = () => {
      if (!closed) timer = setTimeout(connect, 2000);
    };
  };
  const online = () => {
    if (!closed) {
      connect();
      refresh();
    }
  };
  const visible = () => {
    if (document.visibilityState === 'visible') online();
  };
  window.addEventListener('online', online);
  document.addEventListener('visibilitychange', visible);
  connect();
  return () => {
    closed = true;
    clearTimeout(timer);
    socket?.close();
    window.removeEventListener('online', online);
    document.removeEventListener('visibilitychange', visible);
  };
}
