import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import * as nodeModule from 'node:module';
import { dirname, join } from 'node:path';
import { LOCAL_CODEX_NOT_INSTALLED, type AgentConfig } from './agent';
import { spawn } from 'node:child_process';
import { z } from 'zod';

export const agentProgramCheckSchema = z
  .object({
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    observedAt: z.number().int().nonnegative(),
    versionStatus: z.enum(['reported', 'unavailable', 'not-applicable']),
    version: z
      .string()
      .regex(/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/)
      .max(100)
      .optional(),
  })
  .strict()
  .refine(
    (value) => (value.versionStatus === 'reported') === (value.version !== undefined),
    '版本确认状态与版本值不匹配',
  );
export type AgentProgramCheck = z.infer<typeof agentProgramCheckSchema>;
export type LocalAgentProgram = {
  source: 'custom' | 'local' | 'adapter';
  path: string;
  adapterName?: string;
  adapterVersion?: string;
  fingerprint: string;
};

const programRequire = nodeModule.createRequire(import.meta.url);
export function agentAdapterEntry(config: AgentConfig) {
  return config.agentType === 'codex'
    ? '@agentclientprotocol/codex-acp'
    : config.agentType === 'claude'
      ? '@agentclientprotocol/claude-agent-acp/dist/index.js'
      : undefined;
}

function adapter(config: AgentConfig) {
  const entry = agentAdapterEntry(config);
  if (!entry || config.customAcp) return;
  const name =
    config.agentType === 'codex'
      ? '@agentclientprotocol/codex-acp'
      : '@agentclientprotocol/claude-agent-acp';
  const path = programRequire.resolve(entry);
  let parent = dirname(realpathSync(path));
  for (let i = 0; i < 5; i++, parent = dirname(parent)) {
    try {
      const manifest = JSON.parse(readFileSync(join(parent, 'package.json'), 'utf8'));
      if (
        manifest.name === name &&
        typeof manifest.version === 'string' &&
        /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(manifest.version)
      )
        return { path, name, version: manifest.version as string };
    } catch {}
  }
  return { path, name };
}

/** Private local settings only. This descriptor is never part of an Agent catalogue. */
export function localAgentProgram(config: AgentConfig): LocalAgentProgram {
  const fingerprint = agentProgramFingerprint(config);
  if (config.customAcp) return { source: 'custom', path: config.customAcp.command, fingerprint };
  const codexPath = config.agentType === 'codex' ? config.runtimeOverrides?.codexPath : undefined;
  if (config.agentType === 'codex' && !codexPath) throw new Error(LOCAL_CODEX_NOT_INSTALLED);
  let installed: ReturnType<typeof adapter>;
  try {
    installed = adapter(config);
  } catch {}
  if (!installed && codexPath) return { source: 'local', path: codexPath, fingerprint };
  if (!installed) throw new Error('本机 Agent 适配器不可用');
  return {
    source: config.agentType === 'codex' ? 'local' : 'adapter',
    path: codexPath ?? installed.path,
    fingerprint,
    adapterName: installed.name,
    ...(installed.version ? { adapterVersion: installed.version } : {}),
  };
}

type VersionRunner = (command: string, args: string[], cwd: string) => Promise<string>;
const runVersion: VersionRunner = (command, args, cwd) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      detached: process.platform !== 'win32',
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')),
      ),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let bytes = Buffer.alloc(0),
      failed = false;
    const stop = () => {
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(() => {
      failed = true;
      stop();
    }, 10_000);
    child.stdout.on('data', (chunk: Buffer) => {
      if (bytes.length + chunk.length > 4096) {
        failed = true;
        stop();
      } else bytes = Buffer.concat([bytes, chunk]);
    });
    child.stderr.resume();
    child.once('error', () => {
      failed = true;
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (failed || code !== 0) reject(new Error('程序版本不可读取'));
      else resolve(bytes.toString('utf8'));
    });
  });

export async function inspectAgentProgram(
  config: AgentConfig,
  cwd: string,
  run: VersionRunner = runVersion,
  now: () => number = Date.now,
): Promise<AgentProgramCheck> {
  const program = localAgentProgram(config);
  let version: string | undefined;
  const applicable = config.agentType === 'codex' && !config.customAcp;
  if (applicable) {
    try {
      const output = await run(program.path, ['--version'], cwd);
      version = /^codex-cli (\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)\s*$/.exec(output.trim())?.[1];
    } catch {}
  }
  if (program.fingerprint !== agentProgramFingerprint(config))
    throw new Error('诊断期间 Agent 程序已变化');
  return agentProgramCheckSchema.parse({
    fingerprint: program.fingerprint,
    observedAt: now(),
    versionStatus: applicable ? (version ? 'reported' : 'unavailable') : 'not-applicable',
    ...(version ? { version } : {}),
  });
}

// Match a locally selected @openai/codex launcher. No agent account,
// configuration database or external application source is inspected.
function codexFiles(launcher: string): string[] {
  const files = [launcher];
  try {
    const actual = realpathSync(launcher),
      root = dirname(dirname(actual));
    const manifest = join(root, 'package.json');
    if (JSON.parse(readFileSync(manifest, 'utf8')).name !== '@openai/codex') return files;
    files.push(manifest);
    const cpu = process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : '';
    const target =
      process.platform === 'darwin'
        ? `${cpu}-apple-darwin`
        : process.platform === 'linux'
          ? `${cpu}-unknown-linux-musl`
          : `${cpu}-pc-windows-msvc`;
    let vendor = join(root, 'vendor');
    try {
      vendor = join(
        dirname(
          nodeModule
            .createRequire(actual)
            .resolve(`@openai/codex-${process.platform}-${process.arch}/package.json`),
        ),
        'vendor',
      );
    } catch {}
    files.push(join(vendor, target, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex'));
  } catch {}
  return files;
}

/** Opaque change detector, never a public path or a claim about model support. */
export function agentProgramFingerprint(config: AgentConfig): string {
  const files = [process.execPath];
  if (config.customAcp) files.push(config.customAcp.command);
  else {
    const entry = agentAdapterEntry(config);
    if (entry) {
      try {
        const adapter = programRequire.resolve(entry);
        files.push(adapter);
        if (config.agentType === 'codex' && config.runtimeOverrides?.codexPath)
          files.push(...codexFiles(config.runtimeOverrides.codexPath));
      } catch {
        files.push(entry);
      }
    }
  }
  const observations = files.map((file) => {
    try {
      const real = realpathSync(file),
        stat = statSync(real, { bigint: true });
      return [file, real, stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String);
    } catch {
      return [file, 'unavailable'];
    }
  });
  return createHash('sha256')
    .update(JSON.stringify([config, process.version, observations]))
    .digest('hex');
}
