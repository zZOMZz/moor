import { z } from 'zod';
import { CliError } from './args';
import type { CliConnection } from './state';
import {
  localCliChallenge,
  verifyLocalCliProof,
  type LocalCliConnectionLease,
} from '../bridge/local-cli-connection';
export const connectionSchema = z
  .object({
    origin: z.string(),
    cookie: z.string().regex(/^personal=[A-Za-z0-9_-]{20,200}$/),
    owner: z.string().min(1).max(1000),
  })
  .strict();
export function serverOrigin(value: string) {
  try {
    const u = new URL(value);
    if (
      u.origin !== value ||
      u.username ||
      u.password ||
      u.pathname !== '/' ||
      u.search ||
      u.hash ||
      (u.protocol !== 'https:' &&
        !(u.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(u.hostname)))
    )
      throw new Error();
    return u.origin;
  } catch {
    throw new CliError(
      'server',
      '服务器必须是不含凭据或路径的 HTTPS origin，或明确的回环 IP HTTP origin。',
    );
  }
}
export class CliHttpError extends CliError {
  constructor(
    public status: number,
    public rejected: boolean,
  ) {
    super(
      status === 401 ? 'authentication' : status === 409 ? 'conflict' : 'http',
      status === 401
        ? '登录或主机凭据已失效。'
        : rejected
          ? '主机明确拒绝了本次新请求。'
          : '服务器未能确认请求；请核查原操作。',
      status === 401 ? 3 : rejected ? 5 : 4,
    );
  }
}
export function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted)
    return Promise.reject(new CliError('deadline', '请求已超过截止时间或已中断。', 4));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new CliError('deadline', '请求已超过截止时间或已中断。', 4));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
export class CliHttp {
  readonly origin: string;
  constructor(
    readonly connection: CliConnection | { origin: string; cookie?: string; owner?: string },
    readonly options: {
      fetch?: typeof fetch;
      local?: LocalCliConnectionLease;
      signal?: AbortSignal;
      current?: () => void;
      deadline?: (ms: number) => AbortSignal;
    } = {},
  ) {
    this.origin = serverOrigin(connection.origin);
  }
  get owner() {
    return this.options.local?.connection.ownerId ?? this.connection.owner;
  }
  async request(path: string, body?: string, limit = 48 * 1024 * 1024) {
    const signal = AbortSignal.any([
      ...(this.options.signal ? [this.options.signal] : []),
      (this.options.deadline ?? AbortSignal.timeout)(30000),
    ]);
    this.options.current?.();
    if (!path.startsWith('/api/') || path.startsWith('//') || /[\\\r\n#]/.test(path))
      throw new CliError('path', '请求路径不可用。');
    try {
      this.options.local?.assertCurrent();
    } catch {
      throw new CliError(
        'local-connection',
        '本机连接已失效，请重新选择当前连接；原操作尚未发送。',
        3,
      );
    }
    if (this.options.local) {
      try {
        const challenge = localCliChallenge();
        const probe = await withAbort(
          (this.options.fetch ?? fetch)(
            this.origin + '/api/local-instance?challenge=' + challenge,
            {
              redirect: 'error',
              signal,
            },
          ),
          signal,
        );
        if (
          !probe.ok ||
          (probe.headers.get('content-length') &&
            Number(probe.headers.get('content-length')) > 1024)
        )
          throw new Error();
        const reader = probe.body?.getReader();
        let text = '';
        if (reader) {
          while (true) {
            const item = await withAbort(reader.read(), signal);
            if (item.done) break;
            if (text.length + item.value.length > 1024) {
              await reader.cancel();
              throw new Error();
            }
            text += Buffer.from(item.value).toString('utf8');
          }
        }
        verifyLocalCliProof(this.options.local.connection, challenge, JSON.parse(text));
        this.options.local.assertCurrent();
      } catch {
        throw new CliError('local-connection', '本机实例已改变，未向新实例发送凭据。', 3);
      }
    }
    this.options.current?.();
    let response: Response;
    try {
      response = await withAbort(
        (this.options.fetch ?? fetch)(this.origin + path, {
          method: body === undefined ? 'GET' : 'POST',
          redirect: 'error',
          signal,
          headers: {
            'Content-Type': 'application/json',
            Origin: this.origin,
            ...(this.connection.cookie ? { Cookie: this.connection.cookie } : {}),
            ...(this.options.local
              ? { 'X-Moor-Instance': this.options.local.connection.instanceId }
              : {}),
          },
          ...(body === undefined ? {} : { body }),
        }),
        signal,
      );
    } catch {
      throw new CliError('network', '连接中断或请求未能确认；不会自动重发。', 4);
    }
    const bytes: Uint8Array[] = [];
    let size = 0;
    try {
      const reader = response.body?.getReader();
      if (reader) {
        while (true) {
          const item = await withAbort(reader.read(), signal);
          if (item.done) break;
          size += item.value.byteLength;
          if (size > limit) {
            await reader.cancel();
            throw new Error();
          }
          bytes.push(item.value);
        }
      }
    } catch {
      throw new CliError('response', '服务器响应不完整或超过限制。', 4);
    }
    try {
      this.options.local?.assertCurrent();
    } catch {
      throw new CliError('local-connection', '本机实例已改变；原请求结果需要核查。', 3);
    }
    this.options.current?.();
    let value: unknown;
    try {
      value = JSON.parse(Buffer.concat(bytes).toString('utf8'));
    } catch {
      throw new CliError('response', '服务器响应不可验证。', 4);
    }
    if (!response.ok)
      throw new CliHttpError(
        response.status,
        !!value && typeof value === 'object' && (value as { rejected?: unknown }).rejected === true,
      );
    return { value, headers: response.headers };
  }
  async json(path: string, body?: unknown, limit?: number) {
    return (await this.request(path, body === undefined ? undefined : JSON.stringify(body), limit))
      .value;
  }
  async identity() {
    const result = z.object({ owner: z.string().nullable() }).parse(await this.json('/api/me'));
    if (!result.owner || (this.owner && result.owner !== this.owner))
      throw new CliError('authentication', '登录账号与此连接不匹配。', 3);
    return result.owner;
  }
}
