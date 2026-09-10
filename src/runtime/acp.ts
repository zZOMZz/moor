import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import * as nodeModule from 'node:module';
import { isAbsolute } from 'node:path';
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { capabilities } from './capabilities';
import type { AgentDriver } from './agent';
import { resolveRunSelection, selectionFromInput } from '../run-config';
const agentRequire = nodeModule.createRequire(import.meta.url);
export const acpDriver: AgentDriver = {
  async open(config, cwd, nativeId, callbacks) {
    const custom = config.customAcp;
    if (custom && !isAbsolute(custom.command)) throw new Error('ACP 启动程序必须为本机绝对路径');
    const entry =
      config.agentType === 'codex'
        ? '@agentclientprotocol/codex-acp'
        : config.agentType === 'claude'
          ? '@agentclientprotocol/claude-agent-acp/dist/index.js'
          : undefined;
    if (!custom && !entry) throw new Error('不支持的 Agent');
    const child = spawn(
      custom?.command ?? process.execPath,
      custom?.args ?? [agentRequire.resolve(entry!)],
      {
        cwd,
        env: {
          ...process.env,
          ...(config.runtimeOverrides?.codexPath
            ? { CODEX_PATH: config.runtimeOverrides.codexPath }
            : {}),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      },
    );
    child.stderr.resume(); // Raw logs may contain credentials; only protocol errors reach the UI.
    let stopped = false,
      acceptingUpdates = false,
      activeSessionId: string | undefined;
    let forceStop: ReturnType<typeof setTimeout> | undefined;
    const ended = new Promise<void>((resolve) =>
      child.once('close', () => {
        clearTimeout(forceStop);
        resolve();
      }),
    );
    const killOwnedProcess = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // Some application sandboxes deny process-group signals while permitting
        // the direct child handle. Do not target any process outside this launch.
        if (code === 'EPERM' || code === 'EACCES') child.kill(signal);
        else if (code !== 'ESRCH') throw error;
      }
    };
    const close = () => {
      if (!stopped) {
        stopped = true;
        child.stdin.destroy();
        killOwnedProcess('SIGTERM');
        if (child.exitCode === null && child.signalCode === null) {
          forceStop = setTimeout(() => killOwnedProcess('SIGKILL'), 3000);
          forceStop.unref();
        }
      }
      return ended;
    };
    const failed = new Promise<never>((_, reject) => {
      child.once('error', () => reject(new Error('无法启动本机 ACP Agent')));
      child.once('exit', () => reject(new Error('本机 ACP Agent 已退出')));
    });
    // Observe process failures even between protocol requests.
    void failed.catch(() => {});
    const conn = new ClientSideConnection(
      () => ({
        sessionUpdate: async (value) => {
          if (!stopped && acceptingUpdates && value.sessionId === activeSessionId)
            callbacks.update(value.update);
        },
        requestPermission: async (value) =>
          stopped || !acceptingUpdates || value.sessionId !== activeSessionId
            ? { outcome: { outcome: 'cancelled' as const } }
            : callbacks.permission(value),
      }),
      ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      ),
    );
    async function bounded<T>(work: Promise<T>): Promise<T> {
      let timer: ReturnType<typeof setTimeout>;
      try {
        return await Promise.race([
          work,
          failed,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              close();
              reject(new Error('Agent 连接超时，请手动重试'));
            }, 20000);
          }),
        ]);
      } finally {
        clearTimeout(timer!);
      }
    }
    try {
      const init = await bounded(
        conn.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientInfo: { name: 'Moor', version: '0.2.0' },
          clientCapabilities: {},
        }),
      );
      if (nativeId && !init.agentCapabilities?.loadSession)
        throw new Error('该 Agent 不支持恢复会话；请创建新会话');
      const response = nativeId
        ? await bounded(conn.loadSession({ sessionId: nativeId, cwd, mcpServers: [] }))
        : await bounded(conn.newSession({ cwd, mcpServers: [] }));
      const id = nativeId ?? (response as { sessionId: string }).sessionId;
      activeSessionId = id;
      const choices = capabilities(response);
      return {
        id,
        capabilities: choices,
        close,
        async prompt(input) {
          resolveRunSelection(selectionFromInput(input, choices), choices);
          if (input.modelId)
            await bounded(
              conn.setSessionConfigOption({
                sessionId: id,
                configId:
                  (response as any).configOptions?.find(
                    (o: any) => o.category === 'model' || o.id === 'model',
                  )?.id ?? 'model',
                value: input.modelId,
              }),
            );
          if (input.modeId)
            await bounded(conn.setSessionMode({ sessionId: id, modeId: input.modeId }));
          for (const [configId, value] of Object.entries(input.configOptionValues ?? {}))
            await bounded(
              conn.setSessionConfigOption({ sessionId: id, configId, value: String(value) }),
            );
          acceptingUpdates = true;
          try {
            const result = await Promise.race([
              conn.prompt({ sessionId: id, prompt: [{ type: 'text', text: input.prompt }] }),
              failed,
            ]);
            if (!['end_turn', 'cancelled'].includes(result.stopReason))
              throw new Error('Agent 停止执行：' + result.stopReason);
          } finally {
            acceptingUpdates = false;
          }
        },
        async cancel() {
          await bounded(conn.cancel({ sessionId: id }));
        },
      };
    } catch (error) {
      await close();
      throw error;
    }
  },
};
