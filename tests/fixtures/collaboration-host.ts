import { once, EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { Store } from '@moor/gateway/accounts';
import { createApp } from '@moor/gateway/http';
import { RuntimeStore } from '@moor/host/persistence/store';
import { HostWorkspace } from '@moor/host/sessions/workspace';
import { AppError, PROTOCOL } from '@moor/protocol/protocol';
import { syntheticCapabilities } from './agent-capabilities';
import type { Workspace } from '@moor/protocol/catalog';

export async function syntheticCollaboration() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'moor-collaboration-app-'))),
    project = join(root, 'project');
  mkdirSync(project);
  const accounts = new Store(':memory:');
  const ownerSecret = await accounts.setup('owner@synthetic.invalid', 'synthetic-password-only');
  const memberSecret = await accounts.redeemAccountInvitation(
    accounts.inviteAccount(accounts.owner(ownerSecret)).invitation,
    'member@synthetic.invalid',
    'synthetic-password-only',
  );
  const ownerId = accounts.owner(ownerSecret),
    memberId = accounts.owner(memberSecret);
  const ownerActor = {
    kind: 'relay' as const,
    authorityId: accounts.authorityId,
    accountId: ownerId,
  };
  const app = createApp(accounts, {
    origin: 'http://127.0.0.1:0',
    setupToken: 'synthetic-only',
    publicDir: 'dist/public',
  });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const address = app.server.address();
  if (!address || typeof address === 'string') throw Error('missing synthetic address');
  const origin = 'http://127.0.0.1:' + address.port;
  app.setOrigin(origin);
  const device = accounts.redeem(accounts.pair(ownerId), 'Synthetic execution host');
  const runtime = new RuntimeStore(join(root, 'runtime.sqlite')),
    localProjectId = runtime.registerProject(project);
  runtime.registerAgent('synthetic', {
    id: 'synthetic-agent',
    name: 'Synthetic Agent',
    machineId: runtime.workspace.machineId,
    cliType: 'custom',
    agentType: 'synthetic',
    customAcp: { command: '/synthetic/not-executed', args: [] },
  });
  let socket: WebSocket | undefined;
  const prompts: unknown[] = [];
  const promptEvents = new EventEmitter();
  let holdPrompt: { gate: Promise<void>; started(): void; release(): void } | undefined;
  const host = new HostWorkspace(
    runtime,
    {
      open: async () => ({
        id: 'synthetic-native',
        capabilities: syntheticCapabilities,
        prompt: async (input) => {
          const hold = holdPrompt;
          holdPrompt = undefined;
          prompts.push(input);
          hold?.started();
          promptEvents.emit('prompt');
          await hold?.gate;
        },
        close: () => {},
        cancel: async () => {},
      }),
    },
    () => {},
    (sessionId) => {
      if (socket?.readyState === WebSocket.OPEN)
        socket.send(
          JSON.stringify({ type: 'changed', workspaceId: runtime.workspace.id, sessionId }),
        );
    },
  );
  await host.controlManager.control({
    controlVersion: 1,
    action: 'create',
    operationId: 'synthetic-create',
    agentId: 'synthetic-agent',
    workspaceId: runtime.workspace.id,
    userId: runtime.workspace.userId,
    machineId: runtime.workspace.machineId,
    localProjectId,
    sessionId: 'synthetic-session',
    title: '多人离线协作合成会话',
  });
  socket = new WebSocket(origin.replace('http:', 'ws:') + '/bridge', {
    headers: { Authorization: 'Bearer ' + device.token },
  });
  let held: (() => Promise<void>) | undefined;
  socket.on('message', async (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type !== 'request') return;
    try {
      await held?.();
      const result = await host.collaboration.execute(
        message.method,
        message.params,
        message.context,
        () => {
          if (socket?.readyState !== WebSocket.OPEN) throw Error('synthetic connection closed');
        },
      );
      socket!.send(JSON.stringify({ type: 'response', requestId: message.requestId, result }));
    } catch (error) {
      socket!.send(
        JSON.stringify({
          type: 'response',
          requestId: message.requestId,
          error: {
            status: error instanceof AppError ? error.status : 400,
            message: error instanceof Error ? error.message : 'synthetic error',
          },
        }),
      );
    }
  });
  await once(socket, 'open');
  const ready = new Promise<void>((resolve) => {
    socket!.on('message', (raw) => {
      if (JSON.parse(raw.toString()).type === 'ready') resolve();
    });
  });
  socket.send(
    JSON.stringify({
      type: 'hello',
      protocol: PROTOCOL,
      machineId: runtime.workspace.machineId,
      workspaces: [runtime.workspace],
      attentionActor: ownerActor,
    }),
  );
  await ready;
  await host.collaboration.resume(ownerActor, device.id, () => {
    if (socket?.readyState !== WebSocket.OPEN) throw Error('synthetic connection closed');
  });
  const api = (secret: string) => (path: string, body?: unknown) =>
    fetch(origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Cookie: 'personal=' + secret, Origin: origin, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const ownerApi = api(ownerSecret),
    memberApi = api(memberSecret);
  const [space]: Workspace[] = await (await ownerApi('/api/workspaces')).json();
  const replica = space.replicas.find((entry) => entry.localProjectId === localProjectId)!;
  const route = `/api/collaboration/${space.id}/${replica.id}/synthetic-session`;
  const url =
    origin +
    '/?' +
    new URLSearchParams({
      collaboration: '1',
      workspace: space.id,
      replica: replica.id,
      session: 'synthetic-session',
    });
  return {
    accounts,
    app,
    origin,
    ownerId,
    memberId,
    ownerApi,
    memberApi,
    host,
    runtime,
    prompts,
    route,
    url,
    pauseNextPrompt: () => {
      let started!: () => void, release!: () => void;
      const gate = new Promise<void>((done) => {
        release = done;
      });
      const waiting = new Promise<void>((done) => {
        started = done;
      });
      holdPrompt = { gate, started, release };
      return { started: waiting, release };
    },
    waitForPrompts: (count: number) =>
      new Promise<void>((resolve) => {
        const check = () => {
          if (prompts.length >= count) {
            promptEvents.off('prompt', check);
            resolve();
          }
        };
        promptEvents.on('prompt', check);
        check();
      }),
    hold: (callback?: () => Promise<void>) => {
      held = callback;
    },
    close: async () => {
      held = undefined;
      host.close();
      socket?.terminate();
      await app.close();
      runtime.close();
      accounts.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
