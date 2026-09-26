// Actual Host persistence and command reads; ACP-shaped updates are synthetic.
// Agent startup/handshake and a remote Relay are deliberately outside this fixture.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { WebSocketServer } from 'ws';
import { RuntimeStore } from '@moor/host/persistence/store';
import { HostWorkspace } from '@moor/host/sessions/workspace';
import { HostCommandDispatcher } from '@moor/host/commands/host-command';
import { LoroDoc, mirror, putMeta, vv } from '@moor/session/model';
import { desktopWorkspaceRequestSchema } from '@moor/client/workspace-protocol';

const configuration = JSON.parse(process.env.MOOR_STREAM_HOST!);
const now = () => performance.timeOrigin + performance.now();
const projectRoot = join(configuration.directory, 'project');
mkdirSync(projectRoot, { recursive: true });
const store = new RuntimeStore(join(configuration.directory, 'host.sqlite'));
const projectId = store.registerProject(projectRoot);
const scope = {
  workspaceId: store.workspace.id,
  userId: store.workspace.userId,
  machineId: store.workspace.machineId,
  localProjectId: projectId,
  sessionId: 'stream-benchmark-session',
};
const agent = {
  id: 'stream-benchmark-agent',
  name: 'Synthetic stream',
  machineId: scope.machineId,
  cliType: 'custom',
  agentType: 'synthetic',
  customAcp: { command: process.execPath, args: [] },
};
store.machine.set(['agentConfig', agent.id], agent);
store.saveMachine();
store.reserveAttachmentScope(scope);
store.agents.bind(scope, agent);
putMeta(store.meta, 'session-' + scope.sessionId, {
  id: scope.sessionId,
  userId: scope.userId,
  machineId: scope.machineId,
  project: { kind: 'local', localProjectId: projectId },
  agentConfigId: agent.id,
  agentType: agent.agentType,
  cliType: agent.cliType,
  title: 'Synthetic continuous rendering',
  latestUserMsgId: 'benchmark-user',
  lastHandledUserMsgId: 'benchmark-user',
  status: { type: 'working' },
});
const doc = new LoroDoc();
doc.setPeerId('1');
const view = mirror(doc, scope.sessionId);
view.setState((state) => {
  state.session.id = scope.sessionId;
  for (let index = 0; index <= configuration.plan.history; index++)
    state.history.push({
      id: index === configuration.plan.history ? 'benchmark-active' : 'history-' + index,
      role: 'assistant',
      timestamp: '2026-09-26T00:00:00.000Z',
      userId: undefined,
      userTurnId: 'benchmark-user',
      read: undefined,
      inputConfig: undefined,
      finished: index < configuration.plan.history,
      status: undefined,
      fileDiff: null,
      items: [
        {
          type: 'text',
          text:
            index === configuration.plan.history
              ? '## Continuous synthetic output\n\n```ts\n'
              : `Completed synthetic turn ${index}\n\n${'Stable **Markdown** content. '.repeat(25)}\n\n\`\`\`ts\nexport const prior${index} = ${index};\n\`\`\``,
        },
      ],
    });
});
view.dispose();
store.persist(scope.sessionId, doc);
let sequence = 0;
const events: unknown[] = [];
const requests: unknown[] = [];
const failures: unknown[] = [];
const host = new HostWorkspace(
  store,
  {
    async open() {
      throw Error('The synthetic stream fixture must never launch a real Agent');
    },
  },
  () => {},
  () => publish(),
);
const active: Parameters<HostWorkspace['update']>[1] = {
  turnId: 'benchmark-active',
  userTurnId: 'benchmark-user',
  doc,
  stopped: false,
  projectScope: scope,
  rootPath: projectRoot,
  snapshotIssues: [],
  agent,
  execution: {
    ...scope,
    rootPath: projectRoot,
    projectRoot,
    executionId: 'shared',
    executionRevision: 0,
  },
  permissions: new Map(),
};
host.active.set(scope.sessionId, active);
const connectionId = '00000000-0000-4000-8000-000000000001';
const { sessionId: _sessionId, ...executionTarget } = scope;
const target = {
  serverKey: 'local:' + scope.machineId,
  owner: 'synthetic-local',
  deviceId: 'synthetic-device',
  ...executionTarget,
  catalogWorkspaceId: 'synthetic-workspace',
  catalogProjectId: 'synthetic-project',
  replicaId: 'synthetic-replica',
};
const dispatcher = new HostCommandDispatcher({
  ready: () => true,
  workspace: (id) => (id === scope.workspaceId ? host : undefined),
  hasOperation: () => false,
});
let origin = '';
const catalog = () => ({
  source: 'local',
  connectionId,
  origin,
  owner: target.owner,
  targets: [
    {
      target,
      workspaceName: 'Synthetic workspace',
      projectName: 'Streaming benchmark',
      hostName: 'Synthetic Host',
      online: true,
      runtime: host.workspace,
    },
  ],
});
const server = createServer(async (request, response) => {
  const url = new URL(request.url!, origin || 'http://127.0.0.1');
  if (url.pathname === '/rpc') {
    let method = 'parse-request';
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const input = desktopWorkspaceRequestSchema.parse(
        JSON.parse(Buffer.concat(chunks).toString()),
      );
      method = input.action === 'execute' ? input.command.method : input.action;
      const startedAt = now();
      let value: unknown;
      if (input.action === 'catalog') value = catalog();
      else {
        assert.equal(input.action, 'execute');
        if (input.action !== 'execute') throw Error('Unexpected benchmark operation');
        assert.equal(input.connectionId, connectionId);
        for (const [key, expected] of Object.entries(target))
          assert.equal((input.target as Record<string, unknown>)[key], expected);
        value = await dispatcher.execute(input.command);
      }
      const version = vv(active.doc);
      requests.push({
        method: input.action === 'execute' ? input.command.method : 'catalog',
        startedAt,
        endedAt: now(),
        sequence,
        version,
      });
      response.writeHead(200, {
        'content-type': 'application/json',
        'x-benchmark-sequence': String(sequence),
        'x-benchmark-version': version,
      });
      response.end(JSON.stringify({ ok: true, value }));
    } catch (error) {
      failures.push({ at: now(), method, message: String(error) });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          ok: false,
          error: { code: 'synthetic-host', status: 409, rejected: true, message: String(error) },
        }),
      );
    }
    return;
  }
  const file = resolve(
    configuration.assets,
    '.' + (url.pathname === '/' ? '/index.html' : url.pathname),
  );
  if (!file.startsWith(resolve(configuration.assets) + '/') || !existsSync(file)) {
    response.writeHead(404);
    response.end();
    return;
  }
  response.setHeader(
    'content-type',
    (
      {
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.html': 'text/html',
        '.wasm': 'application/wasm',
        '.png': 'image/png',
      } as Record<string, string>
    )[extname(file)] ?? 'application/octet-stream',
  );
  createReadStream(file).pipe(response);
});
const sockets = new WebSocketServer({ server, path: '/events' });
function publish() {
  const notice = {
    source: 'local',
    connectionId,
    owner: target.owner,
    kind: 'changed',
    deviceId: target.deviceId,
    workspaceId: scope.workspaceId,
    sessionId: scope.sessionId,
  };
  for (const socket of sockets.clients)
    socket.send(JSON.stringify({ notice, sequence, at: now() }));
}
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
let producer: ReturnType<typeof fork> | undefined;
let complete: unknown;
let previousCpu = process.cpuUsage(),
  previousCpuTime = now();
const cpu: unknown[] = [];
const cpuTimer = setInterval(() => {
  const at = now(),
    usage = process.cpuUsage();
  cpu.push({
    at,
    percentOneCore:
      ((usage.user - previousCpu.user + usage.system - previousCpu.system) /
        ((at - previousCpuTime) * 1000)) *
      100,
    memory: process.memoryUsage(),
  });
  previousCpu = usage;
  previousCpuTime = at;
  process.send?.({
    type: 'progress',
    at,
    sequence,
    eventCount: events.length,
    requestCount: requests.length,
  });
}, 500);
process.on('message', (message) => {
  const command = message as { type: string };
  if (command.type === 'start') {
    assert.equal(producer, undefined);
    producer = fork(configuration.producer, [], {
      env: {
        ...process.env,
        MOOR_STREAM_PLAN: JSON.stringify(configuration.plan),
        MOOR_STREAM_PRODUCER_REPORT: join(configuration.assets, '..', 'producer-report.json'),
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    producer.stderr?.on('data', (chunk) => process.stderr.write(chunk));
    producer.on('exit', (code, signal) =>
      process.send?.({ type: 'producer-exit', at: now(), code, signal, sequence }),
    );
    producer.on('message', (raw) => {
      const event = raw as {
        type: string;
        sequence: number;
        update: unknown;
        count: number;
        sha256: string;
      };
      if (event.type === 'chunk') {
        const receivedAt = now();
        assert.equal(
          event.sequence,
          sequence + 1,
          'independent producer IPC preserves every sequence',
        );
        sequence = event.sequence;
        host.update(scope.sessionId, active, event.update);
        events.push({ ...event, receivedAt, persistedAt: now() });
      } else if (event.type === 'done') {
        assert.equal(sequence, event.count);
        const final = mirror(active.doc, scope.sessionId);
        const text = final
          .getState()
          .history.at(-1)!
          .items!.filter((item: any) => item.type === 'text')
          .map((item: any) => item.text)
          .join('');
        final.dispose();
        complete = {
          ...event,
          producerHash: event.sha256,
          text,
          version: vv(active.doc),
          sha256: createHash('sha256').update(text).digest('hex'),
          hostFinishedAt: now(),
        };
        publish();
        process.send?.({ type: 'produced', final: complete });
      }
    });
  } else if (command.type === 'report') {
    process.send?.({ type: 'report', events, requests, failures, cpu, final: complete });
  } else if (command.type === 'close') {
    clearInterval(cpuTimer);
    producer?.kill();
    sockets.close();
    server.close();
    host.active.clear();
    host.close();
    store.close();
    process.disconnect();
  }
});
process.send?.({ type: 'ready', origin, sessionId: scope.sessionId, target });
