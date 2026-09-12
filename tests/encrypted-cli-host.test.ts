import test from 'node:test';
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { Store } from '../src/relay/accounts';
import { createApp } from '../src/relay/http';
import { CliState } from '../src/cli/state';
import { DeviceManager } from '../src/security/device-manager';
import { generateRecoveryKey } from '../src/security/e2ee-recovery';
import { PrivateEndpointFile } from '../src/security/private-endpoint-file';
import { RuntimeStore } from '../src/runtime/store';

test(
  'real secure CLI and Host use an opaque production Relay for synthetic execution and durable recovery',
  { timeout: 120000 },
  async (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'moor-secure-cli-'))),
      project = join(root, 'SYNTHETIC_PRIVATE_PROJECT_PATH'),
      privateRoot = join(root, 'private'),
      stateDirectory = join(root, 'client-state');
    mkdirSync(project, { mode: 0o700 });
    mkdirSync(privateRoot, { mode: 0o700 });
    const runtimeFile = join(privateRoot, 'runtime.sqlite'),
      config = join(privateRoot, 'bridge.json'),
      endpointFile = join(privateRoot, 'host.json'),
      clientFile = join(privateRoot, 'client.json'),
      connectionFile = join(privateRoot, 'connection.json'),
      relayFile = join(privateRoot, 'relay.sqlite'),
      syntheticAgent = join(root, 'synthetic-acp.mjs'),
      aggregateFile = join(root, 'synthetic-aggregate.jsonl');
    const packagedApp = process.env.MOOR_TEST_PACKAGED_APP
        ? realpathSync(process.env.MOOR_TEST_PACKAGED_APP)
        : undefined,
      packagedRuntime = packagedApp && join(packagedApp, 'Contents/Resources/app/runtime'),
      executable = packagedApp ? join(packagedApp, 'Contents/MacOS/Electron') : process.execPath;
    writeFileSync(aggregateFile, '', { mode: 0o600 });
    writeFileSync(
      syntheticAgent,
      `import readline from 'node:readline'; import {appendFileSync} from 'node:fs';
const log=process.argv[2], send=v=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...v})+'\\n'); let pending;
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
if(m.method==='initialize') return send({id:m.id,result:{protocolVersion:m.params.protocolVersion,agentCapabilities:{loadSession:true},agentInfo:{name:'Synthetic secure fixture',version:'1'},authMethods:[]}});
if(m.method==='session/new') return send({id:m.id,result:{sessionId:'synthetic-secure-native'}});
if(m.method==='session/load') return send({id:m.id,result:{}});
if(m.method==='session/prompt') {const text=m.params.prompt.filter(p=>p.type==='text').map(p=>p.text).join('');appendFileSync(log,JSON.stringify({event:'prompt',text})+'\\n');const holding=text.includes('hold-for-stop');send({method:'session/update',params:{sessionId:m.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:holding?'synthetic-holding':'SYNTHETIC_PRIVATE_AGENT_RESPONSE'}}}});if(holding)pending=m;else send({id:m.id,result:{stopReason:'end_turn'}});return;}
if(m.method==='session/cancel'){appendFileSync(log,JSON.stringify({event:'cancel'})+'\\n');if(pending)send({id:pending.id,result:{stopReason:'cancelled'}});pending=undefined;return;}
if(m.id!==undefined)send({id:m.id,error:{code:-32601,message:'Unsupported synthetic method'}});
});\n`,
      { mode: 0o600 },
    );
    const children: { child: ChildProcess; closed: Promise<any> }[] = [];
    const store = new Store(relayFile);
    const secret = store.setupGoogle(
      {
        issuer: 'https://accounts.google.com',
        subject: 'synthetic-secure-subject',
        email: 'secure@synthetic.invalid',
        emailVerified: true,
      },
      'synthetic-secure-owner',
    );
    const owner = store.owner(secret),
      app = createApp(store, {
        origin: 'http://127.0.0.1:0',
        setupToken: 'synthetic-unused-setup',
      });
    const captured: { path: string; direction: string; message: any }[] = [];
    const httpRequests: { method: string | undefined; path: string | undefined }[] = [];
    app.server.on('request', (request) =>
      httpRequests.push({ method: request.method, path: request.url }),
    );
    let onRecord: ((message: any, socket: WebSocket) => void) | undefined,
      dropRequestId: string | undefined,
      dropped = 0,
      hostReadyResolve!: () => void;
    let hostReady = new Promise<void>((resolve) => {
      hostReadyResolve = resolve;
    });
    const originalUpgrade = WebSocketServer.prototype.handleUpgrade;
    WebSocketServer.prototype.handleUpgrade = function (request, socket, head, callback) {
      return originalUpgrade.call(this, request, socket, head, (ws, req) => {
        const path = request.url ?? '';
        ws.on('message', (raw: RawData) => {
          const message = JSON.parse(raw.toString());
          captured.push({ path, direction: 'in', message });
          if (path === '/bridge/v4/client' && message.type === 'record') onRecord?.(message, ws);
        });
        const originalSend = ws.send.bind(ws);
        ws.send = ((data: unknown, ...args: any[]) => {
          const message = JSON.parse(String(data));
          captured.push({ path, direction: 'out', message });
          if (path === '/bridge/v4/host' && message.type === 'ready') hostReadyResolve();
          if (
            path === '/bridge/v4/client' &&
            message.type === 'record' &&
            message.record.header.requestId === dropRequestId
          ) {
            dropRequestId = undefined;
            dropped++;
            ws.terminate();
            const callback = args.at(-1);
            if (typeof callback === 'function')
              callback(new Error('Synthetic lost encrypted response'));
            return;
          }
          return (originalSend as any)(data, ...args);
        }) as typeof ws.send;
        callback(ws, req);
      });
    };
    t.after(async () => {
      WebSocketServer.prototype.handleUpgrade = originalUpgrade;
      for (const process of children) {
        if (process.child.exitCode === null && process.child.signalCode === null)
          process.child.kill('SIGKILL');
        await process.closed;
      }
      await app.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    });
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    const address = app.server.address();
    assert(address && typeof address === 'object');
    const origin = 'http://127.0.0.1:' + address.port;
    app.setOrigin(origin);
    const code = generateRecoveryKey(),
      hostManager = await DeviceManager.open(endpointFile),
      clientManager = await DeviceManager.open(clientFile);
    try {
      const initialized = await hostManager.initialize(
        {
          accountId: owner,
          serverOrigin: origin,
          deviceId: 'synthetic-secure-host',
          roles: ['host'],
        },
        code,
      );
      assert('pin' in initialized);
      const pairing = await clientManager.beginPairing({
        pin: initialized.pin,
        deviceId: 'synthetic-secure-client',
        roles: ['client'],
      });
      assert('pending' in pairing && pairing.pending);
      const receipt = await hostManager.approvePairing({
        expectedRevision: initialized.revision!,
        request: pairing.pending.request,
        expectedFingerprint: pairing.fingerprint,
        expectedDeviceKeyId: null,
        recoveryKey: code,
      });
      await clientManager.acceptPairing({
        expectedRevision: pairing.revision!,
        approval: receipt.approval,
        rootPublicKey: receipt.trust.rootPublicKey,
        signedManifest: receipt.trust.signedManifest,
      });
    } finally {
      hostManager.close();
      clientManager.close();
    }
    const connection = PrivateEndpointFile.open(connectionFile);
    connection.save(null, {
      kind: 'moor-trust-connection',
      origin,
      owner,
      cookie: 'personal=' + secret,
    });
    connection.close();
    const state = new CliState(stateDirectory);
    state.set('auth', {
      kind: 'remote',
      connection: { origin, owner, cookie: 'personal=' + secret },
    });
    state.close();

    function child(entry: 'host' | 'cli', args: string[], input = '') {
      const bundled = !!packagedRuntime || process.env.MOOR_TEST_CLI_BUNDLES === '1';
      const child = fork(
          resolve(
            bundled
              ? join(packagedRuntime ?? 'dist', entry === 'host' ? 'bridge.mjs' : 'cli.mjs')
              : entry === 'host'
                ? 'src/bridge/host-main.ts'
                : 'src/cli/main.ts',
          ),
          args,
          {
            ...(packagedRuntime ? { execPath: executable, cwd: root } : {}),
            execArgv: bundled ? [] : ['--import', 'tsx'],
            env: {
              ...process.env,
              MOOR_RUNTIME_DATA: runtimeFile,
              ...(packagedRuntime ? { ELECTRON_RUN_AS_NODE: '1', NODE_PATH: '' } : {}),
            },
            stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
          },
        ),
        closed = once(child, 'close');
      children.push({ child, closed });
      let stdout = '',
        stderr = '';
      child.stdout!.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr!.on('data', (chunk) => {
        stderr += chunk;
      });
      child.stdin!.on('error', () => {});
      child.stdin!.end(input);
      return { child, closed, output: () => ({ stdout, stderr }) };
    }
    async function configure(action: unknown) {
      const result = child(
        'host',
        ['--config', config, '--runtime-data', runtimeFile, '--agent-config-stdin'],
        JSON.stringify(action),
      );
      assert.equal((await result.closed)[0], 0, result.output().stderr);
      return JSON.parse(result.output().stdout);
    }
    const saved = await configure({
      action: 'save',
      expectedRevision: 0,
      name: 'SYNTHETIC_PRIVATE_AGENT_NAME',
      command: realpathSync(executable),
      args: [syntheticAgent, aggregateFile],
    });
    const preset = saved.presets[0];
    const checked = await configure({
      action: 'check',
      expectedRevision: saved.revision,
      id: preset.id,
      versionId: preset.versionId,
    });
    assert.equal(checked.presets[0].checked.ok, true);
    await configure({
      action: 'enabled',
      expectedRevision: checked.revision,
      id: preset.id,
      enabled: true,
    });
    const hostArguments = [
      '--config',
      config,
      '--runtime-data',
      runtimeFile,
      '--project',
      project,
      '--secure-endpoint',
      endpointFile,
      '--secure-connection',
      connectionFile,
    ];
    let currentHost = child('host', hostArguments);
    await Promise.race([
      hostReady,
      currentHost.closed.then(() => {
        throw Error(currentHost.output().stderr);
      }),
    ]);
    async function run(args: string[], input = '', expectedCode = 0) {
      const result = child(
        'cli',
        [
          '--json',
          '--state-dir',
          stateDirectory,
          'secure',
          ...args,
          ...(args[0] === 'operations' ? [] : ['--endpoint', clientFile]),
        ],
        input,
      );
      assert.equal(
        (await result.closed)[0],
        expectedCode,
        result.output().stderr + result.output().stdout,
      );
      const lines = (expectedCode === 0 ? result.output().stdout : result.output().stderr)
        .trim()
        .split('\n')
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line)];
          } catch {
            return [];
          }
        });
      return expectedCode === 0 ? lines.at(-1)?.data : lines.at(-1)?.error;
    }
    const hosts = await run(['hosts']);
    assert.equal(hosts.hosts.length, 1);
    const discovered = await run(['catalog', '--host', 'synthetic-secure-host']);
    const catalog = discovered.catalog ?? discovered;
    assert.equal(catalog.workspaces.length, 1);
    const workspace = catalog.workspaces[0],
      projectId = workspace.projects[0].id,
      agentId = workspace.agents[0].id;
    const target = [
      '--host',
      'synthetic-secure-host',
      '--workspace',
      workspace.id,
      '--project',
      projectId,
    ];
    assert.equal((await run(['list', ...target])).sessions.length, 0);
    const created = await run(
      ['create', ...target, '--agent', agentId, '--stdin'],
      'SYNTHETIC_PRIVATE_SESSION_TITLE',
    );
    assert.equal(created.state, 'accepted');
    const sessionId = created.target.sessionId;
    const read = () => run(['read', sessionId, ...target]);
    const empty = await read();
    assert.deepEqual(empty.history, []);
    assert.deepEqual((await run(['mcp', sessionId, ...target])).servers, []);
    const first = await run(
      ['send', sessionId, ...target, '--stdin'],
      'SYNTHETIC_PRIVATE_PROMPT_ONE',
    );
    assert.equal(first.state, 'accepted');
    async function untilSession(predicate: (session: any) => boolean) {
      // Each observation is a real, read-only Host roundtrip. No sleeps or replayed writes.
      while (true) {
        const session = await read();
        if (predicate(session)) return session;
      }
    }
    const finished = await untilSession(
      (session) =>
        JSON.stringify(session.history).includes('SYNTHETIC_PRIVATE_AGENT_RESPONSE') &&
        session.history.some((item: any) => item.role === 'assistant' && item.finished),
    );
    assert.equal(finished.history.filter((item: any) => item.role === 'user').length, 1);
    assert.equal((await run(['retry', first.operationId])).state, 'accepted');
    assert.equal(
      readFileSync(aggregateFile, 'utf8')
        .trim()
        .split('\n')
        .filter((line) => JSON.parse(line).event === 'prompt').length,
      1,
    );
    const holding = await run(
      ['send', sessionId, ...target, '--stdin'],
      'hold-for-stop SYNTHETIC_PRIVATE_PROMPT_TWO',
    );
    assert.equal(holding.state, 'accepted');
    const active = await untilSession((session) =>
      JSON.stringify(session.history).includes('synthetic-holding'),
    );
    const turn = active.history.find((item: any) => item.role === 'assistant' && !item.finished);
    assert(turn);
    const stopped = await run(['stop', sessionId, ...target, '--turn', turn.id]);
    assert(['pending', 'accepted'].includes(stopped.state));
    await untilSession((session) =>
      session.history.every((item: any) => item.role !== 'assistant' || item.finished),
    );
    const stopInspection = await run(['inspect', stopped.operationId]);
    assert.equal(stopInspection.state, 'accepted');
    assert.equal(stopInspection.inspection.receipt.status, 'accepted');
    for (const action of ['archive', 'restore', 'pin', 'unpin'])
      assert.equal((await run([action, sessionId, ...target])).state, 'accepted');
    assert.equal(
      (await run(['rename', sessionId, ...target, '--stdin'], 'SYNTHETIC_PRIVATE_RENAMED_TITLE'))
        .state,
      'accepted',
    );
    assert.equal((await run(['list', ...target])).sessions.length, 1);
    assert.ok((await run(['operations'])).operations.length >= 8);

    const knownOperations = new Set(
      (await run(['operations'])).operations.map((operation: any) => operation.operationId),
    );
    let lostOriginal: any;
    onRecord = (message) => {
      // The fixture observes only its own private Moor outbox to select a fault
      // after staging. Production Relay code has no access to this endpoint DB.
      const db = new DatabaseSync(join(stateDirectory, 'moor-cli-v1.sqlite'), { readOnly: true });
      try {
        const fresh = db
          .prepare(
            "SELECT value FROM secure_outbox WHERE json_extract(value,'$.state')='pending' AND json_extract(value,'$.kind')='turn' ORDER BY rowid DESC",
          )
          .all()
          .map((row) => JSON.parse(String(row.value)))
          .find((operation) => !knownOperations.has(operation.operationId));
        if (!fresh) return;
        assert.equal(message.record.header.resource.sessionId, sessionId);
        lostOriginal = fresh;
        dropRequestId = message.record.header.requestId;
        onRecord = undefined;
      } finally {
        db.close();
      }
    };
    const lost = await run(
      ['send', sessionId, ...target, '--stdin'],
      'SYNTHETIC_PRIVATE_LOST_RESPONSE_PROMPT',
      6,
    );
    assert.equal(lost.code, 'unknown');
    assert.equal(lost.operationId, lostOriginal.operationId);
    assert.equal(dropped, 1);
    const delivered = await untilSession(
      (session) =>
        session.history.filter((item: any) => item.role === 'user').length === 3 &&
        session.history.every((item: any) => item.role !== 'assistant' || item.finished),
    );
    assert.equal(delivered.history.filter((item: any) => item.role === 'user').length, 3);
    assert.equal(
      (await run(['operations'])).operations.find(
        (operation: any) => operation.operationId === lost.operationId,
      ).state,
      'pending',
    );
    currentHost.child.kill('SIGTERM');
    assert.equal((await currentHost.closed)[0], 0, currentHost.output().stderr);
    hostReady = new Promise<void>((resolve) => {
      hostReadyResolve = resolve;
    });
    currentHost = child('host', hostArguments);
    await Promise.race([
      hostReady,
      currentHost.closed.then(() => {
        throw Error(currentHost.output().stderr);
      }),
    ]);
    const recovered = await run(['retry', lost.operationId]);
    assert.equal(recovered.state, 'accepted');
    const persisted = new CliState(stateDirectory);
    try {
      assert.equal(persisted.secureOperation(lost.operationId)?.body, lostOriginal.body);
      assert.equal(
        persisted.secureOperation(lost.operationId)?.requestVersion,
        lostOriginal.requestVersion,
      );
    } finally {
      persisted.close();
    }
    assert.equal(
      readFileSync(aggregateFile, 'utf8')
        .trim()
        .split('\n')
        .filter((line) => JSON.parse(line).event === 'prompt').length,
      3,
    );
    const afterRestart = await read();
    assert.equal(afterRestart.meta.title, 'SYNTHETIC_PRIVATE_RENAMED_TITLE');
    assert.equal(afterRestart.history.filter((item: any) => item.role === 'user').length, 3);
    assert.equal(
      (await run(['inspect', created.operationId])).inspection.receipt.status,
      'accepted',
    );
    const hostChallenges = captured
      .filter(
        (frame) =>
          frame.path === '/bridge/v4/host' &&
          frame.direction === 'in' &&
          frame.message.type === 'hello',
      )
      .map((frame) => frame.message.hostChallenge);
    assert.equal(hostChallenges.length, 2);
    assert.equal(new Set(hostChallenges).size, 2);
    const priorIds = new Set(
      (await run(['operations'])).operations.map((operation: any) => operation.operationId),
    );
    let undispatchedId: string | undefined, undispatchedRequest: string | undefined;
    onRecord = (message, socket) => {
      const db = new DatabaseSync(join(stateDirectory, 'moor-cli-v1.sqlite'), { readOnly: true });
      try {
        const fresh = db
          .prepare(
            "SELECT value FROM secure_outbox WHERE json_extract(value,'$.state')='pending' AND json_extract(value,'$.kind')='turn' ORDER BY rowid DESC",
          )
          .all()
          .map((row) => JSON.parse(String(row.value)))
          .find((operation) => !priorIds.has(operation.operationId));
        if (!fresh) return;
        undispatchedId = fresh.operationId;
        undispatchedRequest = message.record.header.requestId;
        onRecord = undefined;
        // This observer precedes the production message listener; a closed
        // authenticated socket cannot forward this newly staged request.
        socket.terminate();
      } finally {
        db.close();
      }
    };
    const unavailable = await run(
      ['send', sessionId, ...target, '--stdin'],
      'SYNTHETIC_PRIVATE_NEVER_EXECUTED_PROMPT',
      6,
    );
    assert.equal(unavailable.operationId, undispatchedId);
    assert(
      !captured.some(
        (frame) =>
          frame.path === '/bridge/v4/host' &&
          frame.direction === 'out' &&
          frame.message.record?.header.requestId === undispatchedRequest,
      ),
    );
    const abandoned = await run(['abandon', unavailable.operationId]);
    assert.equal(abandoned.state, 'abandoned');
    assert.equal(abandoned.inspection.receipt.status, 'abandoned');
    assert.equal((await run(['retry', unavailable.operationId])).state, 'abandoned');
    assert.equal(
      (await run(['inspect', unavailable.operationId])).inspection.receipt.status,
      'abandoned',
    );
    assert.equal((await read()).history.filter((item: any) => item.role === 'user').length, 3);
    assert(
      !readFileSync(aggregateFile, 'utf8').includes('SYNTHETIC_PRIVATE_NEVER_EXECUTED_PROMPT'),
    );
    const wire = JSON.stringify(captured);
    const database = JSON.stringify(
      store.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .flatMap((row) =>
          store.db.prepare('SELECT * FROM "' + String(row.name).replaceAll('"', '""') + '"').all(),
        ),
    );
    for (const secret of [
      'SYNTHETIC_PRIVATE_',
      syntheticAgent,
      aggregateFile,
      project,
      'hold-for-stop',
    ]) {
      assert(!wire.includes(secret), 'Relay frames exposed synthetic private content');
      assert(!database.includes(secret), 'Relay SQLite exposed synthetic private content');
    }
    assert(captured.some((frame) => frame.message.type === 'record'));
    assert(captured.every((frame) => frame.path.startsWith('/bridge/v4/')));
    assert(httpRequests.length > 0);
    assert(httpRequests.every((request) => request.method === 'GET' && request.path === '/api/me'));
    assert.equal(
      store.db.prepare('SELECT password,salt FROM account WHERE id=?').get(owner)?.password,
      null,
    );
    currentHost.child.kill('SIGTERM');
    assert.equal((await currentHost.closed)[0], 0, currentHost.output().stderr);
    const promptsBeforeUnsafeStartup = readFileSync(aggregateFile, 'utf8'),
      framesBeforeUnsafeStartup = captured.length;
    const refusedProject = child('host', [...hostArguments, '--project', privateRoot]);
    assert.equal((await refusedProject.closed)[0], 1, refusedProject.output().stderr);
    const worktreePrivate = join(privateRoot, 'worktrees', 'synthetic-sensitive-files');
    mkdirSync(worktreePrivate, { recursive: true, mode: 0o700 });
    for (const [flag, source] of [
      ['--secure-endpoint', endpointFile],
      ['--secure-connection', connectionFile],
    ] as const) {
      const unsafeFile = join(worktreePrivate, flag.slice(2) + '.json');
      copyFileSync(source, unsafeFile);
      const args = hostArguments.map((value, index) =>
        hostArguments[index - 1] === flag ? unsafeFile : value,
      );
      const refusedWorktree = child('host', args);
      assert.equal((await refusedWorktree.closed)[0], 1, refusedWorktree.output().stderr);
    }
    const stored = new RuntimeStore(runtimeFile);
    stored.registerProject(privateRoot);
    stored.close();
    const refusedStoredProject = child('host', hostArguments);
    assert.equal((await refusedStoredProject.closed)[0], 1, refusedStoredProject.output().stderr);
    assert.equal(readFileSync(aggregateFile, 'utf8'), promptsBeforeUnsafeStartup);
    assert.equal(captured.length, framesBeforeUnsafeStartup);
  },
);
