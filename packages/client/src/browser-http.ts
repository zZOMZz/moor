import { WorkspaceNetworkFailure, type WorkspaceJsonTransport } from './workspace-transport';

export class BrowserHttpError extends Error {
  constructor(
    readonly status: number,
    readonly rejected: boolean,
    message: string,
  ) {
    super(message);
  }
}

export function createBrowserWorkspaceHttp(
  options: {
    origin: string;
    fetch?: typeof fetch;
    deadline?: (milliseconds: number) => AbortSignal;
  },
  context: { current(): void; signal: AbortSignal },
): WorkspaceJsonTransport {
  const origin = new URL(options.origin);
  if (
    origin.origin !== options.origin ||
    origin.username ||
    origin.password ||
    (origin.protocol !== 'https:' &&
      !(
        origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
      ))
  )
    throw Error('浏览器工作区必须使用本站 HTTPS 地址或本机回环地址。');
  return {
    origin: options.origin,
    async json(path, body, limit = 48 * 1024 * 1024) {
      const url = new URL(path, origin);
      if (!path.startsWith('/api/') || /[\\\r\n#]/.test(path) || url.origin !== options.origin)
        throw Error('工作区请求路径无效。');
      context.current();
      const signal = AbortSignal.any([
        context.signal,
        (options.deadline ?? AbortSignal.timeout)(30000),
      ]);
      const response = await (options.fetch ?? fetch)(url.href, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
        signal,
        headers: {
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }).catch(() => {
        throw new WorkspaceNetworkFailure('网络连接不可达。');
      });
      context.current();
      if (response.redirected || (response.url && response.url !== url.href))
        throw Error('工作区响应来源已改变。');
      const length = response.headers.get('content-length');
      if (
        (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) ||
        !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')
      ) {
        await response.body?.cancel();
        throw Error('工作区响应不可验证或超过大小限制。');
      }
      const reader = response.body?.getReader();
      if (!reader) throw Error('工作区响应不完整。');
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const part = await reader.read().catch(() => {
            throw new WorkspaceNetworkFailure('响应连接已中断。');
          });
          context.current();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > limit || chunks.length >= 65536) throw Error('工作区响应超过大小或分片限制。');
          chunks.push(part.value);
        }
      } catch (error) {
        await reader.cancel().catch(() => {});
        throw error;
      } finally {
        reader.releaseLock();
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      context.current();
      if (!response.ok)
        throw new BrowserHttpError(
          response.status,
          value?.rejected === true,
          typeof value?.error === 'string' ? value.error : '主机未确认请求。',
        );
      return value;
    },
  };
}
