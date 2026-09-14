import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';

// Only the execution host selects executable paths; never accept them from the relay.
export function localCodexPath(
  env: NodeJS.ProcessEnv = process.env,
  usable = (path: string) => {
    try {
      accessSync(path, constants.X_OK);
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
): string | undefined {
  const explicit = env.MOOR_CODEX_PATH?.trim();
  if (explicit) {
    if (!isAbsolute(explicit) || !usable(explicit))
      throw new Error('MOOR_CODEX_PATH 必须指向可执行文件的绝对路径');
    return explicit;
  }
  const executable = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const candidates = [
    join(homedir(), '.local', 'bin', executable),
    ...(process.platform === 'darwin' ? ['/Applications/Codex.app/Contents/Resources/codex'] : []),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    ...(env.PATH ?? '')
      .split(delimiter)
      .map((directory) => directory.trim())
      // Do not resolve a relative or empty PATH entry against Moor's project cwd.
      .filter(isAbsolute)
      .map((directory) => join(directory, executable)),
  ];
  return [...new Set(candidates)].find(usable);
}

export function withLocalCodex(config: any, path: string | undefined) {
  if (!path || config.agentType !== 'codex' || config.runtimeOverrides?.codexPath) return config;
  return {
    ...config,
    runtimeOverrides: { ...config.runtimeOverrides, codexPath: path },
  };
}
