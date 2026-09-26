// Continuous synthetic Host -> notifications -> real Controller/IndexedDB -> visible Chromium.
// Timings are observations; sequence, scope, durable-cache and final-content checks are assertions.
const { app, BrowserWindow, contentTracing } = require('electron');
const { fork, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const repository = path.resolve(__dirname, '../..');
const source = path.resolve(process.env.MOOR_BENCH_SOURCE_ROOT ?? repository);
const directory =
  process.env.MOOR_E2E_DIRECTORY ??
  fs.mkdtempSync(path.join(os.tmpdir(), 'moor-streaming-performance-'));
const output = path.join(directory, 'output');
const assets = path.join(output, 'assets');
fs.mkdirSync(assets, { recursive: true });
app.setPath('userData', path.join(directory, 'profile'));
const plan = {
  durationMs: Number(process.env.MOOR_STREAM_DURATION_MS ?? 3000),
  rate: Number(process.env.MOOR_STREAM_RATE ?? 60),
  chunkBytes: Number(process.env.MOOR_STREAM_CHUNK_BYTES ?? 64),
  history: Number(process.env.MOOR_STREAM_HISTORY ?? 300),
};
for (const value of Object.values(plan)) assert(Number.isFinite(value) && value > 0);
assert(
  plan.durationMs <= 600000 && plan.rate <= 500 && plan.chunkBytes <= 4096 && plan.history <= 10000,
);
const now = () => performance.timeOrigin + performance.now();
const report = {
  version: 1,
  plan,
  source,
  environment: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    platform: process.platform,
    arch: process.arch,
    cpus: os.cpus().length,
  },
  timeouts: [],
  watchdog: [],
  cpu: [],
  inputs: [],
  errors: [],
  hostProgress: [],
  sourceHashes: Object.fromEntries(
    [
      'apps/web/src/app/workspace-app.tsx',
      'apps/web/src/features/sessions/session-timeline.tsx',
      'apps/web/src/features/sessions/streaming-markdown.tsx',
      'apps/web/src/features/workspace/workspace-controller.ts',
      'packages/host/src/sessions/workspace.ts',
      'packages/session/src/client-session-replica.ts',
      'pnpm-lock.yaml',
    ]
      .filter((file) => fs.existsSync(path.join(source, file)))
      .map((file) => [
        file,
        createHash('sha256')
          .update(fs.readFileSync(path.join(source, file)))
          .digest('hex'),
      ]),
  ),
};
const save = () =>
  fs.writeFileSync(path.join(output, 'streaming-report.json'), JSON.stringify(report, null, 2));
let win,
  host,
  cpuTimer,
  inputTimer,
  watchdogTimer,
  tracing = false;
const bounded = async (promise, milliseconds, label) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        report.timeouts.push({ label, at: now(), milliseconds });
        save();
        reject(Error('Continuous replay deadline: ' + label));
      }, milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
};
const messages = [];
const waiters = new Set();
const hostMessage = (type) => {
  const existing = messages.find((value) => value.type === type);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve) => {
    const listener = (value) => {
      if (value.type === type) {
        waiters.delete(listener);
        resolve(value);
      }
    };
    waiters.add(listener);
  });
};
function alignSequence(events, samples) {
  let next = 0;
  return events.map((event) => {
    while (next < samples.length && !(samples[next].sequence >= event.sequence)) next++;
    return samples[next];
  });
}
const percentile = (values, fraction) =>
  values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1] : null;
const distribution = (values) => ({
  count: values.length,
  p50: percentile(values, 0.5),
  p95: percentile(values, 0.95),
  p99: percentile(values, 0.99),
  max: values.length
    ? values.reduce((maximum, value) => Math.max(maximum, value), -Infinity)
    : null,
});
app
  .whenReady()
  .then(async () => {
    const { build } = await import('esbuild');
    const { workspaceSources } = await import(
      pathToFileURL(path.join(source, 'scripts/build/workspace-sources.mjs')).href
    );
    const { browserWasm } = await import(
      pathToFileURL(path.join(source, 'scripts/build/browser-wasm.mjs')).href
    );
    const { buildWebStyles } = await import(
      pathToFileURL(path.join(source, 'apps/web/scripts/build-styles.mjs')).href
    );
    const sourceImports = {
      name: 'benchmark-product-source-root',
      setup(builder) {
        builder.onResolve({ filter: /^\.\.?\// }, (args) => {
          const absolute = path.resolve(args.resolveDir, args.path);
          if (
            !absolute.startsWith(repository + '/apps/') &&
            !absolute.startsWith(repository + '/packages/')
          )
            return;
          const relocated = source + absolute.slice(repository.length);
          for (const extension of ['', '.ts', '.tsx', '.js', '.cjs'])
            if (fs.existsSync(relocated + extension)) return { path: relocated + extension };
        });
      },
    };
    const signals = {
      name: 'benchmark-commit-signals',
      setup(builder) {
        builder.onLoad(
          { filter: /\/(?:workspace-app\.tsx|composer-input\.tsx|client-session-replica\.ts)$/ },
          ({ path: file }) => {
            let contents = fs.readFileSync(file, 'utf8');
            const inject = (needle, value) => {
              assert(
                contents.includes(needle),
                'Measurement anchor changed: ' + file + ' ' + needle,
              );
              contents = contents.replace(needle, value);
            };
            if (file.endsWith('/workspace-app.tsx'))
              inject(
                '    sessionPerformanceCommitted(',
                '    window.__streamCommitted?.(state.session?.version); sessionPerformanceCommitted(',
              );
            if (file.endsWith('/composer-input.tsx'))
              inject(
                'inputPerformanceCommitted(input.current);',
                'inputPerformanceCommitted(input.current);window.__streamInputCommitted?.();',
              );
            if (file.endsWith('/client-session-replica.ts'))
              inject(
                'this.#view = view;',
                'globalThis.__streamDecoded?.(version);this.#view = view;',
              );
            return { contents, loader: file.endsWith('.tsx') ? 'tsx' : 'ts' };
          },
        );
      },
    };
    await build({
      entryPoints: [path.join(repository, 'tests/fixtures/streaming-workspace.tsx')],
      outfile: path.join(assets, 'fixture.js'),
      bundle: true,
      minify: true,
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' },
      platform: 'browser',
      format: 'esm',
      target: 'chrome120',
      alias: { 'loro-crdt': 'loro-crdt/bundler' },
      plugins: [sourceImports, signals, workspaceSources, browserWasm()],
      loader: { '.wasm': 'file' },
      publicPath: '/',
    });
    await buildWebStyles(path.join(assets, 'style.css'));
    fs.copyFileSync(
      path.join(source, 'apps/web/public/moor-logo.png'),
      path.join(assets, 'moor-logo.png'),
    );
    fs.writeFileSync(
      path.join(assets, 'index.html'),
      '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/style.css"></head><body><div id="app"></div><script type="module" src="/fixture.js"></script></body></html>',
    );
    const hostFile = path.join(output, 'host.mjs');
    const external = {
      name: 'benchmark-shared-wasm-runtime',
      setup(builder) {
        builder.onResolve({ filter: /^(?:loro-crdt|ws)$/ }, (args) => ({
          path:
            args.path === 'ws'
              ? path.join(path.dirname(require.resolve('ws/package.json')), 'wrapper.mjs')
              : require.resolve(args.path),
          external: true,
        }));
      },
    };
    await build({
      entryPoints: [path.join(repository, 'tests/fixtures/streaming-host.ts')],
      outfile: hostFile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node24',
      plugins: [sourceImports, workspaceSources, external],
      banner: {
        js: `import {createRequire as __createRequire} from 'node:module';const require=__createRequire(${JSON.stringify(path.join(source, 'package.json'))});`,
      },
    });
    const node =
      process.env.MOOR_BENCH_NODE ??
      execFileSync('node', ['-p', 'process.execPath'], { encoding: 'utf8' }).trim();
    host = fork(hostFile, [], {
      execPath: node,
      env: {
        ...process.env,
        MOOR_STREAM_HOST: JSON.stringify({
          directory,
          assets,
          plan,
          producer: path.join(repository, 'tests/fixtures/synthetic-stream-producer.mjs'),
        }),
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    host.stdout.on('data', (chunk) => process.stdout.write(chunk));
    host.stderr.on('data', (chunk) => process.stderr.write(chunk));
    host.on('message', (value) => {
      if (value.type === 'progress' || value.type === 'producer-exit')
        report.hostProgress.push(value);
      messages.push(value);
      for (const listener of waiters) listener(value);
    });
    host.on('exit', (code, signal) => {
      report.hostExit = { at: now(), code, signal };
      if (code && report.status !== 'passed')
        report.errors.push('Synthetic Host exited: ' + code + ' / ' + signal);
    });
    const ready = await bounded(hostMessage('ready'), 30000, 'Host startup');
    win = new BrowserWindow({
      show: true,
      width: 1200,
      height: 800,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    win.webContents.on('console-message', (event) => {
      if (event.level === 'error') report.errors.push(event.message);
    });
    const read = (expression) => win.webContents.executeJavaScript(expression);
    const until = (expression) =>
      bounded(
        read(
          `new Promise(resolve=>{const check=()=>{if(${expression})resolve();else requestAnimationFrame(check);};check();})`,
        ),
        15000,
        expression,
      );
    await win.loadURL(ready.origin);
    win.show();
    win.focus();
    await until(`document.querySelector('.workspace-project')`);
    await read(`document.querySelector('.workspace-project').click()`);
    await until(`document.querySelector('.workspace-session-open')`);
    await read(`document.querySelector('.workspace-session-open').click()`);
    await until(
      `window.__streamFixture?.ready() && document.querySelector('[aria-label="消息"]') && !document.querySelector('[aria-label="消息"]').disabled`,
    );
    assert.equal(await read('document.hidden'), false);
    report.environment.browser = await read(
      '({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,visibility:document.visibilityState})',
    );
    report.environment.windowVisible = win.isVisible();
    report.environment.node = node;
    if (process.env.MOOR_STREAM_TRACE === '1') {
      await contentTracing.startRecording({
        recording_mode: 'record-until-full',
        included_categories: ['devtools.timeline', 'blink.user_timing', 'v8', 'cc', 'gpu'],
      });
      tracing = true;
    }
    await read('window.__streamFixture.start()');
    report.startedAt = now();
    app.getAppMetrics();
    cpuTimer = setInterval(() => {
      report.cpu.push({
        at: now(),
        metrics: app
          .getAppMetrics()
          .map(({ pid, type, cpu, memory }) => ({ pid, type, cpu, memory })),
      });
    }, 500);
    inputTimer = setInterval(() => {
      const sequence = report.inputs.length + 1;
      report.inputs.push({ sequence, sentAt: now() });
      win.webContents.sendInputEvent({ type: 'char', keyCode: 'x' });
    }, 100);
    let pendingProbe;
    watchdogTimer = setInterval(() => {
      if (pendingProbe) {
        report.watchdog.push({ at: now(), pendingMs: now() - pendingProbe.at });
        return;
      }
      const probe = { at: now() };
      pendingProbe = probe;
      void read('performance.timeOrigin+performance.now()').then(
        (rendererAt) => {
          report.watchdog.push({
            at: probe.at,
            rendererAt,
            respondedAt: now(),
            responseMs: now() - probe.at,
          });
          pendingProbe = undefined;
        },
        (error) => {
          report.errors.push(String(error));
          pendingProbe = undefined;
        },
      );
    }, 100);
    host.send({ type: 'start' });
    const produced = await bounded(
      hostMessage('produced'),
      plan.durationMs + 15000,
      'independent producer completion',
    );
    report.produced = produced.final;
    report.producerReceivedAt = now();
    clearInterval(inputTimer);
    inputTimer = undefined;
    await bounded(
      read(`window.__streamFixture.waitForFinal(${JSON.stringify(produced.final.version)})`),
      15000,
      'final version committed and IndexedDB durable',
    );
    report.finalDurableAt = now();
    await until('window.__streamFixture.geometry()?.visible');
    const renderer = await bounded(
      read('window.__streamFixture.finish()'),
      10000,
      'cache replay and draft flush',
    );
    report.renderer = renderer;
    host.send({ type: 'report' });
    report.host = await bounded(hostMessage('report'), 5000, 'Host report');
    assert.equal(renderer.visibility, 'visible');
    assert.equal(renderer.offline, false);
    assert.equal(renderer.sessionLoad.status, 'ready');
    assert.equal(renderer.sessionLoad.source, 'host');
    assert.equal(
      renderer.geometry.visible,
      true,
      'latest nonempty streamed code line intersects the conversation viewport',
    );
    assert(
      renderer.geometry.preVerticalOverflow <= 1,
      'streamed code does not hide the latest output in an inner vertical scroller',
    );
    assert(
      report.host.failures.every((value) => value.method === 'agent-options'),
      'only the deliberately unavailable synthetic Agent capability probe may fail',
    );
    assert.equal(renderer.latestSequence, produced.final.count);
    assert.equal(renderer.committedVersion, produced.final.version);
    assert.equal(renderer.cachedVersion, produced.final.version);
    assert.equal(createHash('sha256').update(renderer.text).digest('hex'), produced.final.sha256);
    assert.equal(renderer.cachedText, renderer.text);
    const initialText = '## Continuous synthetic output\n\n```ts\n';
    assert(renderer.text.startsWith(initialText));
    assert.equal(
      createHash('sha256').update(renderer.text.slice(initialText.length)).digest('hex'),
      produced.final.producerHash,
      'independent producer and rendered session have identical content',
    );
    const codeLines = (value) =>
      value
        .split('\n')
        .filter((line) => line.startsWith('// SEQ:') || line.startsWith('export const item'))
        .join('\n');
    assert.equal(
      codeLines(renderer.visibleCode),
      codeLines(renderer.text),
      'every produced code line reaches the real DOM in order',
    );
    assert.equal(
      renderer.finalInput,
      'x'.repeat(report.inputs.length),
      'independently issued input is neither dropped nor sent',
    );
    assert.equal(renderer.inputSequence, report.inputs.length);
    const commits = renderer.samples.filter((value) => value.kind === 'committed');
    const alignedCommits = alignSequence(report.host.events, commits);
    const alignedResponses = alignSequence(
      report.host.events,
      renderer.samples.filter((value) => value.kind === 'response' && value.method === 'session'),
    );
    report.sequenceLatency = report.host.events.map((event, index) => {
      const committed = alignedCommits[index];
      const response = alignedResponses[index];
      return {
        sequence: event.sequence,
        plannedAt: event.plannedAt,
        producedAt: event.producedAt,
        persistedAt: event.persistedAt,
        committedAt: committed?.at ?? null,
        productionLagMs: event.producedAt - event.plannedAt,
        hostQueueMs: event.receivedAt - event.producedAt,
        timedOut: !committed,
        producedToCommitMs: committed ? committed.at - event.producedAt : null,
        hostReceivedToCommitMs: committed ? committed.at - event.receivedAt : null,
        responseToCommitMs: committed && response ? committed.at - response.at : null,
      };
    });
    assert(report.sequenceLatency.every((value) => !value.timedOut));
    const intervals = renderer.frames.map((frame) => frame.interval);
    report.summary = {
      frames: distribution(intervals),
      rafFrequencyEstimate: intervals.length
        ? 1000 / (intervals.reduce((a, b) => a + b, 0) / intervals.length)
        : null,
      stallsOver100Ms: intervals.filter((value) => value > 100).length,
      producedToCommitMs: distribution(
        report.sequenceLatency.map((value) => value.producedToCommitMs),
      ),
      inputEventToCommitMs: distribution(
        renderer.inputFeedback.map((value) => value.committedAt - value.startedAt),
      ),
      inputIssuedToCommitMs: distribution(
        renderer.inputFeedback.map(
          (value, index) => value.committedAt - report.inputs[index].sentAt,
        ),
      ),
      hostReceivedToCommitMs: distribution(
        report.sequenceLatency.map((value) => value.hostReceivedToCommitMs),
      ),
      responseToCommitMs: distribution(
        report.sequenceLatency
          .map((value) => value.responseToCommitMs)
          .filter((value) => value !== null),
      ),
      cacheDrainAfterHostMs: report.finalDurableAt - produced.final.hostFinishedAt,
      producerToHostCompletionMs: produced.final.hostFinishedAt - produced.final.producedAt,
      producerSchedulingLagMs: distribution(
        report.sequenceLatency.map((value) => value.productionLagMs),
      ),
      cacheTransactions: renderer.samples.filter((value) => value.kind === 'cache-transaction')
        .length,
      cacheCheckpoints: renderer.samples.filter(
        (value) => value.kind === 'cache-transaction' && value.checkpoints,
      ).length,
      requestCount: report.host.requests.length,
      producedCount: produced.final.count,
      commits: commits.length,
    };
    report.limitations = [
      'rAF and post-commit rAF are scheduling signals, not physical screen presentation',
      'Visible window and document visibility do not prove continuous OS focus or absence of window occlusion',
      'Final code visibility is a DOM Range/viewport intersection, not evidence of physical display presentation; earlier frozen baseline used a fixed-height nested code scroller',
      'Synthetic ACP-shaped Host.update input bypasses Agent startup and a remote Relay',
      'The synthetic driver rejects the optional Agent capability probe; model options are unavailable while session reads remain online',
      'CPU includes observation overhead; Chromium raw process percentages and Host one-core percentages are separately labeled',
    ];
    fs.writeFileSync(
      path.join(output, 'streaming-final.png'),
      (await win.webContents.capturePage()).toPNG(),
    );
    report.status = 'passed';
    report.producer = JSON.parse(
      fs.readFileSync(path.join(output, 'producer-report.json'), 'utf8'),
    );
    save();
    console.log(JSON.stringify({ output, summary: report.summary, status: report.status }));
  })
  .catch(async (error) => {
    clearInterval(inputTimer);
    report.status = 'failed';
    report.failure = String(error?.stack ?? error);
    const producerReport = path.join(output, 'producer-report.json');
    if (fs.existsSync(producerReport))
      report.producer = JSON.parse(fs.readFileSync(producerReport, 'utf8'));
    if (host?.connected) {
      host.send({ type: 'report' });
      report.host = await bounded(hostMessage('report'), 5000, 'failure Host report').catch(
        () => null,
      );
    }
    if (win && !win.isDestroyed())
      report.renderer = await bounded(
        win.webContents.executeJavaScript('window.__streamFixture?.snapshot()'),
        5000,
        'failure renderer report',
      ).catch(() => null);
    save();
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    clearInterval(inputTimer);
    clearInterval(cpuTimer);
    clearInterval(watchdogTimer);
    if (tracing)
      await contentTracing.stopRecording(path.join(output, 'chromium-trace.json')).catch(() => {});
    if (host?.connected) {
      host.send({ type: 'close' });
      host.disconnect();
    }
    host?.kill();
    win?.destroy();
    app.exit(process.exitCode ?? 0);
  });
