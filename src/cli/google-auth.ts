import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CliError } from './args';
import { serverOrigin, withAbort } from './http';
import type { CliState } from './state';

export const CLI_GOOGLE_FLOW_KEY = 'google-login-v1';
export const CLI_GOOGLE_FAILED =
  'Google 登录未确认完成。请检查当前流程；未知结果不会自动重试，可手动取消后重新登录。';
const opaque = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/)
  .refine((value) => Buffer.from(value, 'base64url').toString('base64url') === value);
const code = z.string().regex(/^[A-F0-9]{4}-[A-F0-9]{4}$/);
const email = z
  .string()
  .min(1)
  .max(320)
  .refine((value) => value.trim() === value && !/[\x00-\x1f\x7f]/.test(value));
const startSchema = z
  .object({
    flowId: opaque,
    secret: opaque,
    code,
    expiresAt: z.number().int().positive().safe(),
    launchPath: z.string(),
  })
  .strict();
const reviewSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending'), mode: z.literal('login') }).strict(),
  z.object({ status: z.literal('ready'), mode: z.literal('login'), email }).strict(),
]);
const flowSchema = z
  .object({
    version: z.literal(1),
    attemptId: z.string().uuid(),
    origin: z.string(),
    revision: z.number().int().positive().safe(),
    expiresAt: z.number().int().positive().safe(),
    phase: z.enum(['starting', 'awaiting', 'reviewed', 'finishing', 'issued', 'cancelling']),
    proof: z.object({ flowId: opaque, secret: opaque }).strict().optional(),
    code: code.optional(),
    email: email.optional(),
    cookie: z
      .string()
      .regex(/^personal=[A-Za-z0-9_-]{43}$/)
      .optional(),
    expectedOwner: z.string().min(1).max(1000).optional(),
  })
  .strict();
type Flow = z.infer<typeof flowSchema>;
type Lease = { revision: number };
const meSchema = z
  .object({
    owner: z.string().min(1).max(160),
    needsSetup: z.literal(false),
    localOnly: z.literal(false),
    google: z
      .object({
        enabled: z.literal(true),
        linked: z.object({ email }).strict(),
        hasPassword: z.boolean(),
      })
      .strict(),
  })
  .strict();
function fail(): never {
  throw new CliError('google-login', CLI_GOOGLE_FAILED, 3);
}
function loginCookie(headers: Headers, origin: string) {
  const cookies = headers.getSetCookie();
  if (cookies.length !== 1) fail();
  const [pair, ...parts] = cookies[0]!.split(';').map((part) => part.trim());
  if (!pair?.startsWith('personal=') || !opaque.safeParse(pair.slice(9)).success) fail();
  const attrs = new Map<string, string | true>();
  for (const part of parts) {
    const index = part.indexOf('='),
      key = (index < 0 ? part : part.slice(0, index)).toLowerCase(),
      value = index < 0 ? true : part.slice(index + 1);
    if (attrs.has(key) || !['path', 'httponly', 'samesite', 'secure', 'max-age'].includes(key))
      fail();
    attrs.set(key, value);
  }
  const age = attrs.get('max-age'),
    sameSite = attrs.get('samesite');
  if (
    attrs.get('path') !== '/' ||
    attrs.get('httponly') !== true ||
    typeof sameSite !== 'string' ||
    sameSite.toLowerCase() !== 'strict' ||
    (attrs.has('secure') && attrs.get('secure') !== true) ||
    (origin.startsWith('https:') && attrs.get('secure') !== true) ||
    typeof age !== 'string' ||
    !/^[1-9]\d{0,7}$/.test(age) ||
    Number(age) > 2592000
  )
    fail();
  return pair;
}

/** A manual browser handoff. Secrets stay in Moor's private CLI state, never in command output. */
export class CliGoogleAuth {
  readonly #options: {
    state: CliState;
    fetch?: typeof fetch;
    signal?: AbortSignal;
    deadline?: (ms: number) => AbortSignal;
    now?: () => number;
  };
  constructor(options: {
    state: CliState;
    fetch?: typeof fetch;
    signal?: AbortSignal;
    deadline?: (ms: number) => AbortSignal;
    now?: () => number;
  }) {
    this.#options = { ...options };
  }
  #now() {
    const now = (this.#options.now ?? Date.now)();
    if (!Number.isSafeInteger(now) || now < 0) fail();
    return now;
  }
  #lease(): Lease {
    return { revision: this.#options.state.settingsRevision() };
  }
  #current(lease: Lease, signal?: AbortSignal) {
    if (
      this.#options.signal?.aborted ||
      signal?.aborted ||
      this.#options.state.settingsRevision() !== lease.revision
    )
      fail();
  }
  #save(lease: Lease, flow: Flow | undefined, updates: Record<string, unknown> = {}) {
    this.#current(lease);
    lease.revision = this.#options.state.compareAndSetSettings(lease.revision, {
      ...updates,
      [CLI_GOOGLE_FLOW_KEY]: flow ? { ...flow, revision: lease.revision + 1 } : undefined,
    });
    if (flow) flow.revision = lease.revision;
  }
  #load(lease: Lease, cancelling = false) {
    const flow = flowSchema.parse(this.#options.state.get(CLI_GOOGLE_FLOW_KEY));
    serverOrigin(flow.origin);
    this.#current(lease);
    if (!cancelling && (flow.revision !== lease.revision || flow.expiresAt <= this.#now())) fail();
    if (flow.phase !== 'starting' && (!flow.proof || !flow.code)) fail();
    if (['reviewed', 'finishing', 'issued'].includes(flow.phase) && !flow.email) fail();
    if (flow.phase === 'issued' && !flow.cookie) fail();
    return flow;
  }
  async #request(
    lease: Lease,
    origin: string,
    path:
      | '/api/auth/google/start'
      | '/api/auth/google/desktop/review'
      | '/api/auth/google/desktop/finish'
      | '/api/auth/google/cancel'
      | '/api/me'
      | '/api/logout',
    body?: unknown,
    cookie?: string,
  ) {
    const signal = AbortSignal.any([
      ...(this.#options.signal ? [this.#options.signal] : []),
      (this.#options.deadline ?? AbortSignal.timeout)(30000),
    ]);
    this.#current(lease, signal);
    const url = serverOrigin(origin) + path;
    const response = await withAbort(
      (this.#options.fetch ?? fetch)(url, {
        method: body === undefined ? 'GET' : 'POST',
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        signal,
        headers: {
          Accept: 'application/json',
          Origin: origin,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(cookie ? { Cookie: cookie } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      signal,
    );
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      this.#current(lease, signal);
      const length = response.headers.get('content-length');
      if (
        response.redirected ||
        (response.url && response.url !== url) ||
        !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') ||
        (length !== null && (!/^\d+$/.test(length) || Number(length) > 4096))
      )
        fail();
      reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader)
        while (true) {
          const chunk = await withAbort(reader.read(), signal);
          this.#current(lease, signal);
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 4096) fail();
          chunks.push(chunk.value);
        }
      const value: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)),
      );
      this.#current(lease, signal);
      if (!response.ok) fail();
      return { value, headers: response.headers };
    } catch {
      if (reader) void reader.cancel().catch(() => {});
      else void response.body?.cancel().catch(() => {});
      return fail();
    } finally {
      reader?.releaseLock();
    }
  }
  async begin(input: { origin: string }) {
    try {
      const origin = serverOrigin(input.origin),
        lease = this.#lease();
      if (this.#options.state.get(CLI_GOOGLE_FLOW_KEY) !== undefined) fail();
      const prior = this.#options.state.get<{
        kind?: string;
        connection?: { origin?: string; owner?: string };
      }>('auth');
      const flow: Flow = {
        version: 1,
        attemptId: randomUUID(),
        origin,
        revision: lease.revision,
        expiresAt: this.#now() + 10 * 60 * 1000,
        phase: 'starting',
        ...(prior?.kind === 'remote' &&
        prior.connection?.origin === origin &&
        typeof prior.connection.owner === 'string'
          ? { expectedOwner: prior.connection.owner }
          : {}),
      };
      this.#save(lease, flow);
      const started = startSchema.parse(
        (
          await this.#request(lease, origin, '/api/auth/google/start', {
            mode: 'login',
            desktop: true,
          })
        ).value,
      );
      if (
        started.expiresAt <= this.#now() ||
        started.expiresAt > this.#now() + 15 * 60 * 1000 ||
        started.launchPath !== '/auth/google/start?flow=' + started.flowId
      )
        fail();
      Object.assign(flow, {
        phase: 'awaiting',
        proof: { flowId: started.flowId, secret: started.secret },
        code: started.code,
        expiresAt: Math.min(flow.expiresAt, started.expiresAt),
      });
      if (flow.expiresAt <= this.#now()) fail();
      this.#save(lease, flow);
      return {
        origin,
        browserUrl: origin + started.launchPath,
        code: started.code,
        expiresAt: flow.expiresAt,
      };
    } catch {
      return fail();
    }
  }
  async review() {
    try {
      const lease = this.#lease(),
        flow = this.#load(lease);
      if (!['awaiting', 'reviewed'].includes(flow.phase)) fail();
      const reviewed = reviewSchema.parse(
        (await this.#request(lease, flow.origin, '/api/auth/google/desktop/review', flow.proof))
          .value,
      );
      if (flow.expiresAt <= this.#now()) fail();
      if (reviewed.status === 'ready') {
        if (flow.email && flow.email !== reviewed.email) fail();
        Object.assign(flow, { phase: 'reviewed', email: reviewed.email });
        this.#save(lease, flow);
      } else if (flow.phase === 'reviewed') fail();
      return { ...reviewed, origin: flow.origin, code: flow.code, expiresAt: flow.expiresAt };
    } catch {
      return fail();
    }
  }
  async finish(input: { expectedEmail: string; expectedCode: string }) {
    try {
      const expected = z.object({ expectedEmail: email, expectedCode: code }).strict().parse(input);
      const lease = this.#lease(),
        flow = this.#load(lease);
      if (
        !['reviewed', 'issued'].includes(flow.phase) ||
        flow.email !== expected.expectedEmail ||
        flow.code !== expected.expectedCode
      )
        fail();
      if (flow.phase === 'reviewed') {
        const reviewed = reviewSchema.parse(
          (await this.#request(lease, flow.origin, '/api/auth/google/desktop/review', flow.proof))
            .value,
        );
        if (
          reviewed.status !== 'ready' ||
          reviewed.email !== expected.expectedEmail ||
          flow.expiresAt <= this.#now()
        )
          fail();
        flow.phase = 'finishing';
        this.#save(lease, flow);
        // Persist the dispatch marker first. A lost response can never issue another login automatically.
        const finished = await this.#request(
          lease,
          flow.origin,
          '/api/auth/google/desktop/finish',
          flow.proof,
        );
        z.object({ ok: z.literal(true) })
          .strict()
          .parse(finished.value);
        flow.cookie = loginCookie(finished.headers, flow.origin);
        flow.phase = 'issued';
        this.#save(lease, flow);
      }
      const me = meSchema.parse(
        (await this.#request(lease, flow.origin, '/api/me', undefined, flow.cookie)).value,
      );
      if (
        me.google.linked.email !== expected.expectedEmail ||
        (flow.expectedOwner && flow.expectedOwner !== me.owner) ||
        flow.expiresAt <= this.#now()
      )
        fail();
      this.#save(lease, undefined, {
        auth: {
          kind: 'remote',
          connection: { origin: flow.origin, owner: me.owner, cookie: flow.cookie },
        },
      });
      return {
        origin: flow.origin,
        owner: me.owner,
        email: me.google.linked.email,
        authenticated: true,
      };
    } catch {
      return fail();
    }
  }
  async cancel() {
    try {
      const lease = this.#lease();
      if (this.#options.state.get(CLI_GOOGLE_FLOW_KEY) === undefined)
        return { cancelled: true, serverConfirmed: false };
      const flow = this.#load(lease, true);
      // Invalidate any in-flight begin/review/finish before contacting the fixed origin.
      if (flow.proof) flow.phase = 'cancelling';
      this.#save(lease, flow);
      let serverConfirmed = false;
      try {
        if (flow.cookie) {
          z.object({ ok: z.literal(true) })
            .strict()
            .parse((await this.#request(lease, flow.origin, '/api/logout', {}, flow.cookie)).value);
          serverConfirmed = true;
        } else if (flow.proof) {
          z.object({ ok: z.literal(true) })
            .strict()
            .parse(
              (await this.#request(lease, flow.origin, '/api/auth/google/cancel', flow.proof))
                .value,
            );
          serverConfirmed = true;
        }
      } catch {
        if (flow.cookie) {
          // Logout can succeed before its response is lost. A read-only check can confirm
          // that this exact cookie is already invalid without issuing another login.
          z.object({
            owner: z.null(),
            needsSetup: z.boolean(),
            localOnly: z.literal(false),
            google: z.object({ enabled: z.boolean() }).strict(),
          })
            .strict()
            .parse(
              (await this.#request(lease, flow.origin, '/api/me', undefined, flow.cookie)).value,
            );
          serverConfirmed = true;
        }
      }
      this.#save(lease, undefined);
      return { cancelled: true, serverConfirmed };
    } catch {
      return fail();
    }
  }
}
