import { CollaborationPage } from '@moor/client/features/collaboration/page';
import { CollaborationBoard, type CollaborationBoardPort } from '../features/collaboration/board';
import { paint, disposeUI } from '../components/ui';
import type { Identity } from '../platform/api';
import { IndexedStorage } from '../platform/indexed-storage';
import {
  browserCollaborationAccess,
  subscribeCollaborationRefresh,
} from '../platform/browser/collaboration';
import type { UiPorts } from '../platform/ui-ports';

export async function bootCollaboration(
  owner: string,
  identity: Promise<Identity | null>,
  ports: UiPorts,
) {
  const query = new URLSearchParams(location.search),
    workspace = query.get('workspace'),
    replica = query.get('replica'),
    session = query.get('session');
  if (!workspace || !replica || !session) {
    paint(
      '#app',
      <main style={{ padding: 24 }}>
        <h1>共享会话</h1>
        <p>请从 Moor 的会话页面打开共享会话，或使用所有者提供的会话链接。</p>
        <p>
          你的账号 ID：<code>{owner}</code>
        </p>
        <a href="/">返回 Moor</a>
      </main>,
      ports,
    );
    return;
  }
  const storage = new IndexedStorage({ databaseName: 'moor-collaboration-v1' });
  const page = new CollaborationPage({
    owner,
    origin: location.origin,
    workspace,
    replica,
    session,
    storage,
    access: browserCollaborationAccess({ owner, workspace, replica, session }),
    uuid: () => crypto.randomUUID(),
    now: Date.now,
    closeStorage: () => storage.close(),
  });
  const subscriptions = new Set<() => void>();
  let unloaded = false,
    disposed = false;
  const close = () => {
    if (disposed) return;
    disposed = true;
    page.close();
    for (const stop of subscriptions) stop();
    subscriptions.clear();
    window.removeEventListener('pagehide', pagehide);
    disposeUI();
  };
  const pagehide = () => {
    unloaded = true;
    close();
  };
  page.onClose(close);
  window.addEventListener('pagehide', pagehide, { once: true });
  try {
    const initial = await page.open(identity);
    page.current();
    const operations: CollaborationBoardPort = {
      current: page.current,
      read: page.read,
      enable: page.enable,
      member: page.member,
      invite: page.invite,
      readDraft: () => {
        page.current();
        return ports.preferences.read(initial.draftKey);
      },
      writeDraft: (value) => {
        page.current();
        ports.preferences.write(initial.draftKey, value);
      },
      copyLink: () => {
        page.current();
        return ports.navigation.copy(location.href);
      },
      now: Date.now,
      subscribeRefresh(listener) {
        page.current();
        const stop = subscribeCollaborationRefresh(() => {
          try {
            page.current();
            listener();
          } catch {
            close();
          }
        });
        subscriptions.add(stop);
        return () => {
          subscriptions.delete(stop);
          stop();
        };
      },
    };
    paint(
      '#app',
      <CollaborationBoard
        client={{
          state: {
            snapshot: initial.client.state.snapshot,
            subscribe: initial.client.state.subscribe,
            sync: initial.client.state.sync,
          },
          control: {
            sendTurn: initial.client.control.sendTurn,
            withdrawTask: initial.client.control.withdrawTask,
          },
        }}
        initial={initial.initial}
        actor={initial.actor}
        ports={operations}
      />,
      ports,
    );
  } catch (cause) {
    close();
    if (unloaded) return;
    paint(
      '#app',
      <main style={{ padding: 24 }}>
        <h1>共享会话暂不可用</h1>
        <p role="alert">{cause instanceof Error ? cause.message : '尚未确认，请检查连接。'}</p>
        <p>
          你的账号 ID：<code>{owner}</code>
        </p>
        <a href="/">返回 Moor</a>
      </main>,
      ports,
    );
  }
}
