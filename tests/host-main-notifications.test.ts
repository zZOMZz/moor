import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import { RuntimeStore } from '../src/runtime/store';
import { LoroDoc, mirror, putMeta } from '../src/model';
import { relayNotificationChannel } from '../src/bridge/notification-dispatch';
import {
  hostNotificationEventSchema,
  type HostNotificationEvent,
} from '../src/notification-protocol';

function signal<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test(
  'host-main sends private native IPC and authenticated-ready relay metadata, then persists relay acknowledgement',
  { timeout: 15000 },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'moor-notification-main-')),
      file = join(dir, 'runtime.sqlite'),
      configFile = join(dir, 'bridge.json'),
      relay = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    await once(relay, 'listening');
    const address = relay.address();
    assert.equal(typeof address, 'object');
    assert.ok(address);
    const origin = 'http://127.0.0.1:' + (address as { port: number }).port;
    writeFileSync(
      configFile,
      JSON.stringify({ server: origin, id: 'synthetic-device', token: 'synthetic-token' }),
      { mode: 0o600 },
    );
    const projectRoot = join(dir, 'project');
    mkdirSync(projectRoot);
    const store = new RuntimeStore(file),
      projectId = store.registerProject(projectRoot);
    const scope = {
      userId: store.workspace.userId,
      machineId: store.workspace.machineId,
      workspaceId: store.workspace.id,
      localProjectId: projectId,
      sessionId: 'synthetic-session',
      turnId: 'synthetic-turn',
    };
    const doc = new LoroDoc(),
      view = mirror(doc, scope.sessionId);
    view.setState((state) => {
      state.history.push({
        id: scope.turnId,
        role: 'assistant',
        timestamp: '2026-01-01T00:00:00Z',
        userId: undefined,
        userTurnId: undefined,
        read: undefined,
        inputConfig: undefined,
        finished: true,
        status: 'handled',
        items: [{ type: 'text', text: 'synthetic private session body' }],
        fileDiff: null,
      });
    });
    view.dispose();
    putMeta(store.meta, 'session-' + scope.sessionId, {
      id: scope.sessionId,
      userId: scope.userId,
      machineId: scope.machineId,
      project: { kind: 'local', localProjectId: projectId },
      status: { type: 'idle' },
    });
    store.reserveAttachmentScope({
      workspaceId: scope.workspaceId,
      userId: scope.userId,
      machineId: scope.machineId,
      localProjectId: projectId,
      sessionId: scope.sessionId,
    });
    store.persist(scope.sessionId, doc);
    const original = store.notifications.record(scope, 'completed');
    store.close();
    const native = signal<HostNotificationEvent>(),
      remote = signal<HostNotificationEvent>(),
      receiptProcessed = signal<void>();
    let ready = false;
    relay.on('connection', (socket, request) => {
      assert.equal(request.headers.authorization, 'Bearer synthetic-token');
      socket.on('message', (bytes) => {
        const message = JSON.parse(bytes.toString());
        if (message.type === 'hello') {
          ready = true;
          socket.send(JSON.stringify({ type: 'ready' }));
        } else if (message.type === 'notification') {
          assert.equal(ready, true);
          const event = hostNotificationEventSchema.parse(message.event);
          remote.resolve(event);
          socket.send(
            JSON.stringify({ type: 'notification-ack', eventId: event.eventId, status: 'handled' }),
          );
          // Ordered frames on this exact socket prove the acknowledgement was
          // handled before the following read-only RPC response.
          socket.send(
            JSON.stringify({
              type: 'request',
              requestId: 'synthetic-read',
              method: 'sessions',
              workspaceId: scope.workspaceId,
              localProjectId: projectId,
              params: {},
            }),
          );
        } else if (message.type === 'response' && message.requestId === 'synthetic-read') {
          assert.equal(message.error, undefined);
          receiptProcessed.resolve();
        }
      });
    });
    const child = fork(
      resolve('src/bridge/host-main.ts'),
      ['--desktop', '--config', configFile, '--runtime-data', file],
      {
        execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      },
    );
    const exited = once(child, 'exit');
    let errors = '';
    child.stderr?.on('data', (data) => {
      errors = (errors + data.toString()).slice(-2000);
    });
    child.on('message', (input) => {
      const message = input as { type?: string; event?: unknown };
      if (message.type === 'notification')
        native.resolve(hostNotificationEventSchema.parse(message.event));
    });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
      for (const socket of relay.clients) socket.terminate();
      await new Promise<void>((done) => relay.close(() => done()));
    });
    const events = await Promise.race([
      Promise.all([native.promise, remote.promise, receiptProcessed.promise]),
      exited.then(() => {
        throw new Error('Synthetic host exited before notification delivery: ' + errors);
      }),
    ]);
    assert.deepEqual(events.slice(0, 2), [original, original]);
    assert.equal(JSON.stringify(events).includes('private session body'), false);
    child.kill('SIGTERM');
    const [code, signalName] = await exited;
    assert.equal(code, 0, errors);
    assert.equal(signalName, null);
    const restarted = new RuntimeStore(file);
    try {
      assert.deepEqual(
        restarted.notifications.pending(relayNotificationChannel('synthetic-device', origin)),
        [],
      );
      assert.deepEqual(restarted.notifications.pending('native:' + scope.machineId), [original]);
      assert.equal(
        restarted.journal.db.prepare('SELECT count(*) AS n FROM notification_delivery').get()!.n,
        1,
      );
      assert.equal(
        restarted.journal.db.prepare('SELECT count(*) AS n FROM agent_session').get()!.n,
        0,
      );
    } finally {
      restarted.close();
    }
  },
);
