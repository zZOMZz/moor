import { z } from 'zod';
import { id } from '@moor/protocol/protocol';
import { createBrowserWorkspaceHttp } from '@moor/client/browser-http';

/** Revoke only the reviewed account; an old response must not clear a newer login. */
export async function logoutBrowserAccount(options: {
  owner: string;
  origin: string;
  identity(): Promise<{ owner: string | null }>;
  current(): void;
  fetch?: typeof fetch;
}) {
  const owner = id.parse(options.owner);
  options.current();
  if ((await options.identity()).owner !== owner) throw Error('账号已改变，未退出新的账号。');
  options.current();
  const http = createBrowserWorkspaceHttp(
    { origin: options.origin, fetch: options.fetch },
    { current: options.current, signal: AbortSignal.timeout(30000) },
  );
  z.object({ ok: z.literal(true) })
    .strict()
    .parse(await http.json('/api/logout?expectedAccount=' + encodeURIComponent(owner), {}, 4096));
  options.current();
  // No logout Set-Cookie is issued by the Relay. If another tab logged in while
  // the reply was pending, do not clear its cache hint or report it logged out.
  const after = z
    .object({ owner: id.nullable() })
    .parse(await http.json('/api/me', undefined, 4096));
  options.current();
  if (after.owner !== null) throw Error('登录已改变，请重新读取当前账号；不会退出新的登录。');
}
