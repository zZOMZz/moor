import { spawn, type SpawnOptionsWithoutStdio } from 'node:child_process';
import * as nodeModule from 'node:module';
import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import {
  agentUsageUpdateSchema,
  MOOR_USAGE_READ,
  type AgentUsageUpdate,
} from '@moor/protocol/agent-usage';
import { LOCAL_CODEX_NOT_INSTALLED, type AgentConfig } from '../driver';

export function supportsUsage(init: any) {
  const meta = init?.agentCapabilities?._meta?.moor;
  return meta?.version === 1 && meta?.rateLimits?.read === MOOR_USAGE_READ;
}

/** Initializes an ACP transport only: no new/load session, prompts, or permissions. */
export async function readAcpUsage(
  config: AgentConfig,
  cwd: string,
  current: () => void,
  launch = (command: string, args: string[], options: SpawnOptionsWithoutStdio) =>
    spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] }),
): Promise<AgentUsageUpdate> {
  current();
  const custom = config.customAcp,
    codex = config.runtimeOverrides?.codexPath;
  if (!custom && config.agentType !== 'codex')
    return { version: 1, sequence: 0, status: 'unsupported' };
  if (custom && !isAbsolute(custom.command)) throw Error('ACP 启动程序必须为本机绝对路径');
  if (!custom) {
    if (config.agentType !== 'codex' || !codex || !isAbsolute(codex))
      throw Error(LOCAL_CODEX_NOT_INSTALLED);
    accessSync(codex, constants.X_OK);
    if (!statSync(codex).isFile()) throw Error(LOCAL_CODEX_NOT_INSTALLED);
  }
  const child = launch(
    custom?.command ?? process.execPath,
    custom?.args ?? [
      nodeModule.createRequire(import.meta.url).resolve('@agentclientprotocol/codex-acp'),
    ],
    {
      cwd,
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => !key.toUpperCase().startsWith('GIT_') && (custom || key !== 'CODEX_PATH'),
          ),
        ),
        ...(codex ? { CODEX_PATH: codex } : {}),
      },
    },
  );
  child.stderr!.resume();
  const closed = new Promise<void>((done) => child.once('close', () => done()));
  const failed = new Promise<never>((_, reject) => {
    child.once('error', () => reject(Error('无法启动 Agent 额度查询')));
    child.once('exit', () => reject(Error('Agent 额度查询连接已关闭')));
  });
  void failed.catch(() => {});
  const conn = new ClientSideConnection(
    () => ({
      sessionUpdate: async () => {},
      requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
    }),
    ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
    ),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      failed,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('Agent 额度查询超时')), 20_000);
      }),
      (async () => {
        const init = await conn.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientInfo: { name: 'Moor', version: '0.2.0' },
          clientCapabilities: { _meta: { moor: { version: 1 } } },
        });
        current();
        if (!supportsUsage(init))
          return { version: 1, sequence: 0, status: 'unsupported' } as const;
        const result = agentUsageUpdateSchema.parse(await conn.extMethod(MOOR_USAGE_READ, {}));
        current();
        return result;
      })(),
    ]);
  } finally {
    clearTimeout(timer);
    child.stdin!.destroy();
    try {
      if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
    await closed;
  }
}
