import test from 'node:test';
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RuntimeStore } from '../src/runtime/store';

test(
  'real CLI and headless host roundtrip: private login, empty create, synthetic ACP send/wait/stop, metadata and restart recovery',
  { timeout: 60000 },
  async (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'moor-cli-roundtrip-'))),
      project = join(root, 'project'),
      privateRoot = join(root, 'private'),
      state = join(root, 'client');
    mkdirSync(project, { mode: 0o700 });
    mkdirSync(privateRoot, { mode: 0o700 });
    const runtimeFile = join(privateRoot, 'runtime.sqlite'),
      config = join(privateRoot, 'bridge.json'),
      descriptor = config + '.cli.json';
    const runtime = new RuntimeStore(runtimeFile);
    runtime.registerProject(project);
    runtime.registerAgent('synthetic-cli', {
      id: 'synthetic-cli-agent',
      name: 'Synthetic CLI',
      machineId: runtime.workspace.machineId,
      cliType: 'custom',
      agentType: 'synthetic',
      customAcp: {
        command: process.execPath,
        args: [resolve('tests/support/synthetic-acp-cli.mjs')],
      },
    });
    runtime.close();
    const children: { child: ChildProcess; closed: Promise<any> }[] = [];
    t.after(async () => {
      for (const item of children) {
        if (item.child.exitCode === null && item.child.signalCode === null)
          item.child.kill('SIGKILL');
        await item.closed;
      }
      rmSync(root, { recursive: true, force: true });
    });
    function child(entry: string, args: string[], input?: string) {
      const bundled = process.env.MOOR_TEST_CLI_BUNDLES === '1';
      const child = fork(
          resolve(
            bundled ? (entry.includes('/bridge/') ? 'dist/bridge.mjs' : 'dist/cli.mjs') : entry,
          ),
          args,
          {
            execArgv: bundled ? [] : ['--import', 'tsx'],
            env: { ...process.env, MOOR_RUNTIME_DATA: runtimeFile },
            stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
          },
        ),
        closed = once(child, 'close');
      children.push({ child, closed });
      let stdout = '',
        stderr = '',
        buffered = '';
      const events: any[] = [],
        waiters = new Set<{ match(event: any): boolean; done(event: any): void }>();
      function emit(event: any) {
        events.push(event);
        for (const waiter of waiters)
          if (waiter.match(event)) {
            waiters.delete(waiter);
            waiter.done(event);
          }
      }
      child.on('message', emit);
      child.stdout!.on('data', (chunk) => {
        stdout += chunk;
        buffered += chunk;
        let end: number;
        while ((end = buffered.indexOf('\n')) >= 0) {
          const line = buffered.slice(0, end);
          buffered = buffered.slice(end + 1);
          try {
            emit(JSON.parse(line));
          } catch {
            /* Host progress is ordinary text. */
          }
        }
      });
      child.stderr!.on('data', (chunk) => {
        stderr += chunk;
      });
      child.stdin!.end(input ?? '');
      return {
        child,
        closed,
        output: () => ({ stdout, stderr }),
        wait(match: (event: any) => boolean) {
          const found = events.find(match);
          return found
            ? Promise.resolve(found)
            : Promise.race([
                new Promise<any>((done) => waiters.add({ match, done })),
                closed.then(() => {
                  throw new Error('Child exited before synthetic signal: ' + stderr);
                }),
              ]);
        },
      };
    }
    function host() {
      return child('src/bridge/host-main.ts', [
        '--local',
        '--config',
        config,
        '--runtime-data',
        runtimeFile,
        '--public-dir',
        resolve('src/web/public'),
      ]);
    }
    function cli(args: string[], input?: string) {
      return child('src/cli/main.ts', ['--json', '--state-dir', state, ...args], input);
    }
    async function run(args: string[], input?: string) {
      const proc = cli(args, input);
      const [status] = await proc.closed;
      assert.equal(status, 0, proc.output().stderr);
      const lines = proc
        .output()
        .stdout.trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const last = lines.at(-1)!;
      assert.equal(last.cliVersion, 1);
      assert.equal(last.ok, true);
      return last.data;
    }
    let currentHost = host();
    await currentHost.wait((m) => m.type === 'health' && m.local === 'ready');
    assert.equal((await run(['auth', 'login', '--connection', descriptor])).authenticated, true);
    assert.equal((await run(['auth', 'status'])).kind, 'local');
    const targets = (await run(['targets', 'list'])).targets;
    assert.equal(targets.length, 1);
    const target = targets[0].target;
    await run([
      'targets',
      'use',
      '--workspace',
      target.catalogWorkspaceId,
      '--replica',
      target.replicaId,
    ]);
    const created = await run(
      ['session', 'create', '--agent', 'synthetic-cli-agent', '--stdin'],
      'CLI 合成会话',
    );
    assert.equal(created.state, 'accepted');
    const sessionId = created.target.sessionId;
    const empty = await run(['session', 'read']);
    assert.equal(empty.meta.id, sessionId);
    assert.deepEqual(empty.history, []);
    const sent = await run(
      ['session', 'send', '--stdin', '--wait', '--timeout', '15000'],
      '你好，保留 `正文`。',
    );
    assert.equal(sent.operation.state, 'accepted');
    assert.equal(sent.result.history.filter((item: any) => item.role === 'user').length, 1);
    assert.match(JSON.stringify(sent.result.history), /合成 CLI 往返完成/);
    const retry = await run(['operation', 'retry', sent.operation.operationId]);
    assert.equal(retry.state, 'accepted');
    assert.equal(
      (await run(['session', 'read'])).history.filter((item: any) => item.role === 'user').length,
      1,
    );
    const file = join(root, 'prompt.txt');
    writeFileSync(file, 'hold-for-stop');
    const following = cli(['session', 'send', '--file', file, '--follow', '--timeout', '15000']);
    const active = await following.wait(
      (m) =>
        m.data?.event === 'session' && JSON.stringify(m.data.history).includes('synthetic-holding'),
    );
    const assistant = active.data.history.find(
      (item: any) => item.role === 'assistant' && !item.finished,
    );
    assert.ok(assistant);
    const stopped = await run([
      'session',
      'stop',
      '--turn',
      assistant.id,
      '--wait',
      '--timeout',
      '15000',
    ]);
    assert.equal(stopped.operation.receipt.status, 'accepted');
    assert.equal((await following.closed)[0], 0, following.output().stderr);
    assert.equal(
      (await run(['operation', 'inspect', stopped.operation.operationId])).inspection.receipt
        .status,
      'accepted',
    );
    for (const action of ['archive', 'restore', 'pin', 'unpin'])
      assert.equal((await run(['session', action])).state, 'accepted');
    assert.equal(
      (await run(['session', 'rename', '--stdin'], '改名后的 CLI 会话')).receipt.meta.title,
      '改名后的 CLI 会话',
    );
    assert.equal((await run(['session', 'list'])).sessions.length, 1);
    assert.equal((await run(['config', 'show'])).target.sessionId, sessionId);
    assert.ok((await run(['operation', 'list'])).operations.length >= 9);
    currentHost.child.kill('SIGTERM');
    assert.equal((await currentHost.closed)[0], 0);
    currentHost = host();
    await currentHost.wait((m) => m.type === 'health' && m.local === 'ready');
    const resumed = await run(['session', 'read']);
    assert.equal(resumed.meta.title, '改名后的 CLI 会话');
    assert.equal(resumed.history.filter((item: any) => item.role === 'user').length, 2);
    assert.equal(
      (await run(['operation', 'inspect', created.operationId])).inspection.receipt.status,
      'accepted',
    );
    assert.equal((await run(['auth', 'logout'])).authenticated, false);
    assert.equal((await run(['auth', 'login', '--connection', descriptor])).authenticated, true);
    currentHost.child.kill('SIGTERM');
    assert.equal((await currentHost.closed)[0], 0);
  },
);
