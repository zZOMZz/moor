import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createRequire as previewRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Readable } from 'node:stream';
import { AppError } from '../protocol';
import {
  PREVIEW_LIMITS,
  previewActionSchema,
  previewElementSchema,
  previewFrameSchema,
  previewPathSchema,
  previewViewportSchema,
  type PreviewFrame,
} from '../preview-protocol';
import type { PreviewCheckpoint, PreviewDriver, PreviewRendererBinding } from './preview-driver';

const PINNED_ELECTRON = '44.3.0';
const MAX_REPLY = 6 * 1024 * 1024;
type Options = {
  electronPath?: string;
  workerPath?: string;
  timeoutMs?: number;
  /** Synthetic process transport; never provided through remote configuration. */
  spawn?: (executable: string, args: string[], options: SpawnOptions) => ChildProcess;
};
type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout };
type Connection = {
  previewId: string;
  nonce: string;
  closed: boolean;
  child?: ChildProcess;
  directory?: string;
  pending: Map<string, Pending>;
  ready: Promise<void>;
  resolveReady(): void;
  rejectReady(error: Error): void;
  chain: Promise<unknown>;
};
const failure = () => new AppError(409, '预览渲染连接不可用或已关闭');

function cleanEnvironment(directory: string, nonce: string) {
  const env: NodeJS.ProcessEnv = {};
  // Inherit only OS/session essentials, never agent credentials, injected Node flags or proxies.
  for (const key of [
    'PATH',
    'HOME',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'DISPLAY',
    'XAUTHORITY',
    'SystemRoot',
    'WINDIR',
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.MOOR_PREVIEW_DATA = directory;
  env.MOOR_PREVIEW_NONCE = nonce;
  return env;
}

export function createPreviewRenderer(options: Options = {}): PreviewDriver {
  const connections = new Map<string, Connection>();
  const tombstones = new Set<string>();
  const timeoutMs = options.timeoutMs ?? PREVIEW_LIMITS.operationMs;
  const launch = options.spawn ?? spawn;
  let configured: Promise<{ electron: string; worker: string }> | undefined;
  let capability:
    | {
        until: number;
        promise: Promise<{ available: boolean; reason?: string }>;
      }
    | undefined;

  function config() {
    return (configured ??= (async () => {
      let electron = options.electronPath;
      if (!electron && process.versions.electron === PINNED_ELECTRON) electron = process.execPath;
      if (!electron) {
        try {
          const candidate: unknown = previewRequire(import.meta.url)('electron');
          if (typeof candidate === 'string') electron = candidate;
        } catch {
          // A Node-only host can report this capability unavailable.
        }
      }
      if (!electron || !path.isAbsolute(electron)) throw failure();
      const directory = path.dirname(fileURLToPath(import.meta.url));
      let worker = options.workerPath;
      if (!worker) {
        for (const candidate of [
          path.join(directory, 'preview-renderer.cjs'),
          path.resolve(directory, '../desktop/preview-renderer.cjs'),
        ]) {
          try {
            await access(candidate, constants.R_OK);
            worker = candidate;
            break;
          } catch {
            /* Next bundled location. */
          }
        }
      }
      if (!worker || !path.isAbsolute(worker)) throw failure();
      await Promise.all([access(electron, constants.X_OK), access(worker, constants.R_OK)]);
      return { electron, worker };
    })());
  }
  function current(connection: Connection, check?: PreviewCheckpoint) {
    if (
      connection.closed ||
      tombstones.has(connection.previewId) ||
      connections.get(connection.previewId) !== connection
    )
      throw failure();
    check?.assertCurrent();
  }
  function stopped(connection: Connection) {
    connection.closed = true;
    connection.rejectReady(failure());
    for (const pending of connection.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(failure());
    }
    connection.pending.clear();
  }
  async function closeConnection(connection: Connection) {
    stopped(connection);
    const child = connection.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      // A dedicated renderer has no state to recover. Kill it without waiting for page unload.
      child.kill('SIGKILL');
      await new Promise<void>((resolve) => {
        child.once('close', resolve);
        if (child.exitCode !== null || child.signalCode !== null) resolve();
      });
    }
    if (connection.directory) await rm(connection.directory, { recursive: true, force: true });
  }
  function allocate(previewId: string) {
    if (
      tombstones.has(previewId) ||
      connections.has(previewId) ||
      connections.size >= PREVIEW_LIMITS.instances ||
      tombstones.size >= 10_000
    )
      throw failure();
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    void ready.catch(() => {});
    const connection: Connection = {
      previewId,
      nonce: randomUUID(),
      closed: false,
      pending: new Map(),
      ready,
      resolveReady,
      rejectReady,
      chain: Promise.resolve(),
    };
    connections.set(previewId, connection);
    return connection;
  }
  async function start(connection: Connection, check?: PreviewCheckpoint) {
    const resolved = await config();
    current(connection, check);
    const directory = await mkdtemp(path.join(tmpdir(), 'moor-preview-'));
    connection.directory = directory;
    try {
      current(connection, check);
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    const child = launch(resolved.electron, [resolved.worker], {
      env: cleanEnvironment(directory, connection.nonce),
      cwd: directory,
      stdio: ['pipe', 'ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    connection.child = child;
    const output = child.stdio[3] as Readable | null;
    if (!output || !child.stdin) {
      await closeConnection(connection);
      throw failure();
    }
    let buffer = Buffer.alloc(0);
    let ready = false;
    const timer = setTimeout(() => {
      stopped(connection);
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref();
    output.on('data', (chunk: Buffer) => {
      if (connection.closed) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_REPLY) {
        stopped(connection);
        child.kill('SIGKILL');
        return;
      }
      let newline: number;
      while ((newline = buffer.indexOf(10)) >= 0) {
        const line = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        try {
          const message = JSON.parse(line.toString('utf8'));
          if (!message || message.nonce !== connection.nonce) throw failure();
          if (message.ready === true) {
            if (ready || message.electron !== PINNED_ELECTRON) throw failure();
            ready = true;
            clearTimeout(timer);
            connection.resolveReady();
            continue;
          }
          const pending = connection.pending.get(message.id);
          if (!ready || !pending) throw failure();
          clearTimeout(pending.timer);
          connection.pending.delete(message.id);
          if (message.ok === true) pending.resolve(message.result);
          else
            pending.reject(
              new AppError(
                409,
                typeof message.message === 'string' &&
                  /^[\u3000-\u9fff，。；！、\s]{1,100}$/.test(message.message)
                  ? message.message
                  : '预览操作失败，页面可能已变化',
              ),
            );
        } catch {
          stopped(connection);
          child.kill('SIGKILL');
          return;
        }
      }
    });
    child.on('error', () => {
      clearTimeout(timer);
      stopped(connection);
    });
    child.once('close', () => {
      clearTimeout(timer);
      stopped(connection);
    });
    await connection.ready;
    current(connection, check);
  }
  function request(connection: Connection, payload: Record<string, unknown>) {
    current(connection);
    const requestId = randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        stopped(connection);
        connection.child?.kill('SIGKILL');
      }, timeoutMs);
      timer.unref();
      connection.pending.set(requestId, { resolve, reject, timer });
      const line =
        JSON.stringify({
          ...payload,
          previewId: connection.previewId,
          id: requestId,
          nonce: connection.nonce,
        }) + '\n';
      if (Buffer.byteLength(line) > 64 * 1024) {
        clearTimeout(timer);
        connection.pending.delete(requestId);
        reject(failure());
        return;
      }
      connection.child!.stdin!.write(line, (error) => {
        if (error) {
          stopped(connection);
          connection.child?.kill('SIGKILL');
        }
      });
    });
  }
  function serial<T>(connection: Connection, operation: () => Promise<T>): Promise<T> {
    const task = connection.chain.then(operation, operation);
    connection.chain = task.catch(() => {});
    return task;
  }
  function frame(value: unknown, previewId: string): PreviewFrame {
    const result = previewFrameSchema.parse(value);
    const bytes = Buffer.from(result.image.data, 'base64');
    if (
      result.previewId !== previewId ||
      result.image.version !== 'sha256:' + createHash('sha256').update(bytes).digest('hex') ||
      bytes.length < 24 ||
      !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
      bytes.readUInt32BE(16) !== result.viewport.width ||
      bytes.readUInt32BE(20) !== result.viewport.height
    )
      throw failure();
    return result;
  }
  function get(previewId: string) {
    const connection = connections.get(previewId);
    if (!connection) throw failure();
    current(connection);
    return connection;
  }
  const driver: PreviewDriver = {
    async available() {
      if (capability && Date.now() < capability.until) return capability.promise;
      const promise = (async () => {
        let connection: Connection | undefined;
        try {
          connection = allocate('probe-' + randomUUID());
          await start(connection);
          const result = await request(connection, { command: 'probe' });
          if (!(result as { available?: boolean })?.available) throw failure();
          return { available: true };
        } catch {
          return { available: false, reason: '需要可启动的已锁定 Electron 渲染器和图形环境' };
        } finally {
          if (connection) {
            connections.delete(connection.previewId);
            await closeConnection(connection);
          }
        }
      })();
      capability = { until: Infinity, promise };
      const result = await promise;
      if (capability.promise === promise)
        capability.until = Date.now() + (result.available ? 60_000 : 5_000);
      return result;
    },
    async open(binding: PreviewRendererBinding, check) {
      previewViewportSchema.parse(binding.viewport);
      previewPathSchema.parse(binding.startPath);
      const origin = new URL(binding.origin);
      if (
        origin.protocol !== 'http:' ||
        !['127.0.0.1', '[::1]'].includes(origin.hostname) ||
        Number(origin.port || '80') < 1 ||
        origin.origin !== binding.origin
      )
        throw failure();
      check.assertCurrent();
      const connection = allocate(binding.previewId);
      try {
        await start(connection, check);
        current(connection, check);
        check.beforeDispatch?.();
        current(connection, check);
        const value = await request(connection, { command: 'open', binding });
        current(connection, check);
        return frame(value, binding.previewId);
      } catch (error) {
        tombstones.add(binding.previewId);
        connections.delete(binding.previewId);
        await closeConnection(connection);
        throw error;
      }
    },
    async capture(previewId, check) {
      const connection = get(previewId);
      return serial(connection, async () => {
        current(connection, check);
        const value = await request(connection, { command: 'capture' });
        current(connection, check);
        return frame(value, previewId);
      });
    },
    async locate(previewId, frameId, point, check) {
      const connection = get(previewId);
      return serial(connection, async () => {
        current(connection, check);
        const value = await request(connection, { command: 'locate', frameId, ...point });
        current(connection, check);
        const element = previewElementSchema.nullable().parse(value);
        if (element && element.frameId !== frameId) throw failure();
        return element;
      });
    },
    async interact(input, check) {
      const parsed = previewActionSchema.parse(input);
      if (parsed.action === 'open') throw failure();
      const connection = get(parsed.previewId);
      return serial(connection, async () => {
        current(connection, check);
        const prepared = await request(connection, { command: 'prepare', request: parsed });
        current(connection, check);
        const preparedId = (prepared as { preparedId?: unknown })?.preparedId;
        if (typeof preparedId !== 'string' || preparedId.length > 200) throw failure();
        check.beforeDispatch?.();
        current(connection, check);
        const value = await request(connection, { command: 'dispatch', preparedId });
        current(connection, check);
        return frame(value, parsed.previewId);
      });
    },
    async close(previewId) {
      tombstones.add(previewId);
      const connection = connections.get(previewId);
      connections.delete(previewId);
      if (connection) await closeConnection(connection);
    },
    async closeAll() {
      await Promise.all([...connections.keys()].map((previewId) => driver.close(previewId)));
    },
  };
  return driver;
}
