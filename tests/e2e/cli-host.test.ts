import test from 'node:test';
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RuntimeStore } from '@moor/host/persistence/store';
import { Store } from '@moor/gateway/accounts';
import { createApp } from '@moor/gateway/http';

for (const transport of ['local', 'relay'] as const)
  test(
    `${transport}: built CLI and Host create, send, deduplicate, stop, organize and recover through synthetic ACP`,
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
      const packagedApp = process.env.MOOR_TEST_PACKAGED_APP
          ? realpathSync(process.env.MOOR_TEST_PACKAGED_APP)
          : undefined,
        executable = packagedApp ? join(packagedApp, 'Contents/MacOS/Electron') : process.execPath,
        packagedRuntime = packagedApp && join(packagedApp, 'Contents/Resources/app/runtime'),
        syntheticAgent = join(root, 'synthetic-acp-cli.mjs');
      copyFileSync(resolve('tests/fixtures/synthetic-acp-cli.mjs'), syntheticAgent);
      const runtime = new RuntimeStore(runtimeFile);
      runtime.registerProject(project);
      runtime.registerAgent('synthetic-cli', {
        id: 'synthetic-cli-agent',
        name: 'Synthetic CLI',
        machineId: runtime.workspace.machineId,
        cliType: 'custom',
        agentType: 'synthetic',
        customAcp: {
          command: executable,
          args: [syntheticAgent],
        },
      });
      runtime.close();
      const children: { child: ChildProcess; closed: Promise<any> }[] = [];
      let relay: ReturnType<typeof createApp> | undefined;
      let accounts: Store | undefined;
      t.after(async () => {
        for (const item of children) {
          if (item.child.exitCode === null && item.child.signalCode === null)
            item.child.kill('SIGKILL');
          await item.closed;
        }
        await relay?.close();
        accounts?.close();
        rmSync(root, { recursive: true, force: true });
      });
      let origin = '',
        pairCode = '';
      const credentials = {
        email: 'synthetic@example.invalid',
        password: 'synthetic-e2e-password',
      };
      if (transport === 'relay') {
        accounts = new Store(join(privateRoot, 'relay.sqlite'));
        const token = await accounts.setup(credentials.email, credentials.password);
        pairCode = accounts.pair(accounts.owner(token));
        relay = createApp(accounts, {
          origin: 'http://127.0.0.1:0',
          setupToken: 'synthetic',
          publicDir: resolve('dist/public'),
        });
        relay.server.listen(0, '127.0.0.1');
        await once(relay.server, 'listening');
        const address = relay.server.address();
        assert(address && typeof address !== 'string');
        origin = `http://127.0.0.1:${address.port}`;
        relay.setOrigin(origin);
      }
      function child(entry: string, args: string[], input?: string) {
        const child = fork(resolve(packagedRuntime ?? 'dist', entry), args, {
            ...(packagedRuntime ? { execPath: executable, cwd: root } : {}),
            execArgv: [],
            env: {
              ...process.env,
              MOOR_RUNTIME_DATA: runtimeFile,
              ...(packagedRuntime ? { ELECTRON_RUN_AS_NODE: '1', NODE_PATH: '' } : {}),
            },
            stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
          }),
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
        const flags =
          transport === 'local'
            ? ['--local']
            : pairCode
              ? ['--server', origin, '--pair', pairCode]
              : [];
        pairCode = '';
        return child('bridge.mjs', [
          ...flags,
          '--config',
          config,
          '--runtime-data',
          runtimeFile,
          '--public-dir',
          packagedRuntime ? join(packagedRuntime, 'public') : resolve('apps/web/public'),
        ]);
      }
      const ready = (message: any) =>
        message.type === 'health' &&
        message.local === 'ready' &&
        (transport === 'local' || message.deviceMetadata?.sync === 'synced');
      function cli(args: string[], input?: string) {
        return child('cli.mjs', ['--json', '--state-dir', state, ...args], input);
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
      const login = () =>
        transport === 'local'
          ? run(['auth', 'login', '--connection', descriptor])
          : run(['auth', 'login', '--server', origin, '--stdin'], JSON.stringify(credentials));
      let currentHost = host();
      await currentHost.wait(ready);
      assert.equal((await login()).authenticated, true);
      assert.equal(
        (await run(['auth', 'status'])).kind,
        transport === 'local' ? 'local' : 'remote',
      );
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
          m.data?.event === 'session' &&
          JSON.stringify(m.data.history).includes('synthetic-holding'),
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
      await currentHost.wait(ready);
      const resumed = await run(['session', 'read']);
      assert.equal(resumed.meta.title, '改名后的 CLI 会话');
      assert.equal(resumed.history.filter((item: any) => item.role === 'user').length, 2);
      assert.equal(
        (await run(['operation', 'inspect', created.operationId])).inspection.receipt.status,
        'accepted',
      );
      assert.equal((await run(['auth', 'logout'])).authenticated, false);
      assert.equal((await login()).authenticated, true);
      currentHost.child.kill('SIGTERM');
      assert.equal((await currentHost.closed)[0], 0);
    },
  );
