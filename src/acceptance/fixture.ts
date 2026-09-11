import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WebSocket } from 'ws';
import { HostWorkspace } from '../bridge/host-workspace';
import { mirror, putMeta } from '../model';
import { AppError, assert, mutationSchema, PROTOCOL } from '../protocol';
import { Store, token } from '../relay/accounts';
import { createApp } from '../relay/http';
import type { AgentDriver } from '../runtime/agent';
import { RuntimeStore } from '../runtime/store';
import type { RunCapabilities } from '../run-config';

const capabilities: RunCapabilities = {
  models: [{ id: 'acceptance-model', name: '验收演示模型', efforts: [] }],
  modes: [{ id: 'read-only', name: '演示模式' }],
};

// This driver has no process, filesystem, network or real agent integration.
const syntheticDriver: AgentDriver = {
  async open(_config, _cwd, nativeId, callbacks) {
    let closed = false;
    return {
      id: nativeId ?? 'acceptance-native-' + randomUUID(),
      capabilities,
      async prompt() {
        if (!closed)
          callbacks.update({
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: '已收到这条验收演示消息。这是合成回复，未连接真实 Agent，也未修改项目。',
            },
          });
      },
      async cancel() {
        closed = true;
      },
      close() {
        closed = true;
      },
    };
  },
};

export type AcceptanceFixture = {
  origin: string;
  // Native main installs the existing HttpOnly login cookie; never put this in a scene or URL.
  secret: string;
  scope: {
    accountId: string;
    deviceId: string;
    workspaceId: string;
    runtimeWorkspaceId: string;
    projectId: string;
    replicaId: string;
    sessionId: string;
  };
  close(): Promise<void>;
};

/** Isolated real Moor UI, relay and host. The caller owns a fresh directory and its removal. */
export async function createAcceptanceFixture(options: {
  publicDir: string;
  dataDir: string;
}): Promise<AcceptanceFixture> {
  const dataDir = resolve(options.dataDir);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  assert(readdirSync(dataDir).length === 0, 409, '验收数据目录必须为空');
  const projectPath = join(dataDir, 'project');
  mkdirSync(projectPath, { mode: 0o700 });

  let store: Store | undefined;
  let runtime: RuntimeStore | undefined;
  let host: HostWorkspace | undefined;
  let app: ReturnType<typeof createApp> | undefined;
  let socket: WebSocket | undefined;
  let closing = false;
  let closed: Promise<void> | undefined;
  const requests = new Set<Promise<void>>();
  const send = (message: unknown) => {
    if (!closing && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };
  const close = () =>
    (closed ??= (async () => {
      closing = true;
      const failures: unknown[] = [];
      const cleanup = async (operation: () => unknown) => {
        try {
          await operation();
        } catch (error) {
          failures.push(error);
        }
      };
      await cleanup(async () => {
        if (socket && socket.readyState !== WebSocket.CLOSED) {
          const ended = new Promise<void>((resolve) => socket!.once('close', () => resolve()));
          socket.terminate();
          await ended;
        }
      });
      await cleanup(() => Promise.allSettled([...requests]));
      const turns = [...(host?.active.values() ?? [])].map((turn) => turn.done);
      await cleanup(() => host?.close());
      await cleanup(() => Promise.allSettled(turns));
      await cleanup(() => app?.close());
      await cleanup(() => store?.close());
      await cleanup(() => runtime?.close());
      if (failures.length) throw new AggregateError(failures, '验收环境清理失败');
    })());

  try {
    store = new Store(join(dataDir, 'catalog.sqlite'));
    chmodSync(join(dataDir, 'catalog.sqlite'), 0o600);
    const secret = await store.setup(
      'acceptance@localhost.invalid',
      token(),
      'acceptance-' + randomUUID(),
    );
    const accountId = store.owner(secret);
    const device = store.localDevice(accountId, '验收演示主机');
    runtime = new RuntimeStore(join(dataDir, 'runtime.sqlite'));
    runtime.workspace.name = '验收演示执行环境';
    runtime.save('identity', Buffer.from(JSON.stringify(runtime.workspace)));
    const localProjectId = runtime.registerProject(projectPath);
    runtime.machine.set(['localProject', localProjectId], {
      id: localProjectId,
      name: 'Moor 验收演示',
      rootPath: projectPath,
    });
    const agentId = 'acceptance-agent';
    runtime.machine.set(['agentConfig', agentId], {
      id: agentId,
      name: '验收演示 Agent',
      machineId: runtime.workspace.machineId,
      cliType: 'builtin',
      agentType: 'codex',
    });
    runtime.machine.set(['capabilities', agentId], capabilities as never);
    runtime.saveMachine();
    const seeds = [
      {
        id: 'acceptance-modal',
        title: '窄屏弹窗验收',
        prompt: '检查窄屏下的设置弹窗：内容可以滚动，底部操作保持可见。',
        response: '演示现场已准备。打开设置后，可以检查标题、输入区和底部操作的布局。',
      },
      {
        id: 'acceptance-settings',
        title: '设置保存验收',
        prompt: '修改工作区名称，保存后重新打开设置，确认名称仍然保留。',
        response: '请在设置中修改名称并保存。验收环境中的修改独立保存，重置现场后恢复初始数据。',
      },
      {
        id: 'acceptance-session',
        title: '会话抽屉验收',
        prompt: '检查会话抽屉：切换会话后内容正确，关闭后可以继续输入。',
        response: '这里有三条合成会话。可以切换不同会话，确认标题和内容对应，并试着发送一条消息。',
      },
    ];
    for (const [index, seed] of seeds.entries()) {
      const userTurnId = seed.id + '-user';
      const doc = runtime.doc(seed.id);
      const view = mirror(doc, seed.id);
      const timestamp = `2026-01-01T00:00:0${index}Z`;
      view.setState((state) => {
        state.session.id = seed.id;
        state.history.push({
          id: userTurnId,
          role: 'user',
          userId: runtime!.workspace.userId,
          userTurnId: undefined,
          timestamp,
          status: 'handled',
          read: true,
          finished: true,
          items: [{ type: 'text', text: seed.prompt }],
          inputConfig: {
            prompt: seed.prompt,
            cliType: 'builtin',
            agentType: 'codex',
            mcpServerIds: [],
            taskToolsEnabled: false,
          },
          fileDiff: null,
        });
        state.history.push({
          id: seed.id + '-assistant',
          userTurnId,
          role: 'assistant',
          userId: undefined,
          read: undefined,
          inputConfig: undefined,
          timestamp,
          status: 'handled',
          finished: true,
          items: [
            { type: 'text', text: seed.response + '\n\n这是隔离的合成数据，不会连接真实 Agent。' },
          ],
          fileDiff: null,
        });
      });
      view.dispose();
      putMeta(runtime.meta, 'session-' + seed.id, {
        id: seed.id,
        title: seed.title,
        machineId: runtime.workspace.machineId,
        userId: runtime.workspace.userId,
        createdAt: timestamp,
        cliType: 'builtin',
        agentType: 'codex',
        agentConfigId: agentId,
        project: { kind: 'local', localProjectId },
        status: { type: 'idle' },
        isArchived: false,
        latestUserMsgId: userTurnId,
        lastHandledUserMsgId: userTurnId,
        lastMessageAt: Date.parse(timestamp),
      });
      runtime.persist(seed.id, doc);
    }
    const hello = () =>
      send({
        type: 'hello',
        protocol: PROTOCOL,
        machineId: runtime!.workspace.machineId,
        workspaces: [runtime!.workspace],
      });
    host = new HostWorkspace(runtime, syntheticDriver, hello, (sessionId) =>
      send({ type: 'changed', workspaceId: runtime!.workspace.id, sessionId }),
    );
    app = createApp(store, {
      origin: 'http://127.0.0.1:0',
      setupToken: token(),
      publicDir: resolve(options.publicDir),
      localOnly: true,
    });
    const listening = once(app.server, 'listening');
    app.server.listen(0, '127.0.0.1');
    await listening;
    const address = app.server.address();
    assert(address && typeof address === 'object', 500, '无法启动验收界面');
    const origin = 'http://127.0.0.1:' + address.port;
    app.setOrigin(origin);
    socket = new WebSocket(origin.replace('http:', 'ws:') + '/bridge', {
      headers: { Authorization: 'Bearer ' + device.token },
    });
    socket.on('error', () => {});
    const ready = new Promise<void>((resolve, reject) => {
      const error = (error: Error) => {
        cleanup();
        reject(error);
      };
      const ended = () => error(new Error('验收执行环境在就绪前断开'));
      const message = (raw: WebSocket.RawData) => {
        try {
          if (JSON.parse(raw.toString()).type === 'ready') {
            cleanup();
            resolve();
          }
        } catch (cause) {
          error(cause instanceof Error ? cause : new Error('验收执行环境响应无效'));
        }
      };
      const cleanup = () => {
        socket!.off('error', error);
        socket!.off('close', ended);
        socket!.off('message', message);
      };
      socket!.once('error', error);
      socket!.once('close', ended);
      socket!.on('message', message);
    });
    const receive = async (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'watch' || message.type === 'unwatch') {
        assert(message.workspaceId === host!.workspace.id, 400, '工作区不匹配');
        if (message.type === 'watch') host!.checkProject(message.sessionId, message.localProjectId);
        await host!.watch(message.sessionId, message.type === 'watch');
      } else if (message.type === 'request') {
        try {
          assert(message.workspaceId === host!.workspace.id && !closing, 409, '执行环境不可用');
          if (message.localProjectId)
            assert(message.localProjectId === localProjectId, 404, '项目副本不可用');
          let result: unknown;
          if (message.method === 'sessions') result = host!.list(message.localProjectId);
          else if (message.method === 'session')
            result = await host!.read(
              message.params.sessionId,
              message.params.version,
              message.localProjectId,
            );
          else if (message.method === 'agent-options')
            result = await host!.refreshAgentOptions(
              message.params.agentId,
              message.localProjectId,
            );
          else if (message.method === 'mutate') {
            const mutation = mutationSchema.parse(message.params);
            assert(mutation.workspaceId === message.workspaceId, 400, '工作区不匹配');
            result = await host!.mutate(mutation, message.localProjectId);
          } else if (message.method === 'cancel')
            result = await host!.cancel(
              message.params.sessionId,
              message.params.turnId,
              message.localProjectId,
            );
          else throw new AppError(400, '不支持的操作');
          send({ type: 'response', requestId: message.requestId, result });
        } catch (error) {
          send({
            type: 'response',
            requestId: message.requestId,
            error: {
              status: error instanceof AppError ? error.status : 502,
              message: error instanceof AppError ? error.message : '验收执行环境处理失败',
              rejected:
                (error instanceof AppError && error.rejected) ||
                (message.method === 'mutate' &&
                  typeof message.params?.operationId === 'string' &&
                  !runtime!.journal.has(message.params.operationId)),
            },
          });
        }
      }
    };
    socket.on('message', (raw) => {
      if (closing) return;
      const request = receive(raw).catch(() => socket?.close(1008, 'invalid message'));
      requests.add(request);
      void request.finally(() => requests.delete(request));
    });
    socket.once('open', hello);
    await ready;
    const workspace = store.catalog.list(accountId, () => [host!.workspace])[0];
    const replica = workspace.replicas[0];
    assert(replica && app.online(device.id), 500, '验收项目尚未绑定');
    return {
      origin,
      secret,
      scope: {
        accountId,
        deviceId: device.id,
        workspaceId: workspace.id,
        runtimeWorkspaceId: host.workspace.id,
        projectId: replica.projectId,
        replicaId: replica.id,
        sessionId: seeds[0].id,
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
