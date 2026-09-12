import { z } from 'zod';
import {
  e2eeIdSchema,
  e2eeOriginSchema,
  rootPublicJwkSchema,
  trustPinSchema,
  VerifiedTrust,
  type RootPublicJwk,
  type TrustPin,
} from './e2ee-trust';
import {
  TRUST_PUBLICATION_LIMITS,
  TRUST_PUBLICATION_VERSION,
  publicTrustEntrySchema,
  trustPageSchema,
  trustPublishReceiptSchema,
  trustPublishSchema,
  trustReadSchema,
  verifyPublicTrustEntry,
  type PublicTrustEntry,
  type TrustPublishReceipt,
  type TrustPage,
  type TrustRead,
} from './trust-publication';

export const TRUST_CLIENT_FAILED =
  '公开信任操作未确认完成；请先读取本机状态，再手动核对。不会自动重试。';
export const trustConnectionSchema = z
  .object({
    kind: z.literal('moor-trust-connection'),
    origin: e2eeOriginSchema,
    owner: e2eeIdSchema,
    cookie: z.string().regex(/^personal=[A-Za-z0-9_-]{20,200}$/),
  })
  .strict();
export type TrustConnection = z.infer<typeof trustConnectionSchema>;
export type TrustClientOptions = {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  deadline?: (ms: number) => AbortSignal;
  current?: () => void;
};
const identitySchema = z
  .object({
    owner: e2eeIdSchema.nullable(),
    needsSetup: z.boolean(),
    localOnly: z.boolean().optional(),
    google: z
      .object({
        enabled: z.boolean(),
        linked: z
          .object({ email: z.string().max(320) })
          .strict()
          .nullable()
          .optional(),
        hasPassword: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
function fail(): never {
  throw new Error(TRUST_CLIENT_FAILED);
}
async function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => {});
    return fail();
  }
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(new Error(TRUST_CLIENT_FAILED));
    signal.addEventListener('abort', aborted, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

/** Public signed trust only. The three fixed routes cannot dispatch Host or Agent operations. */
export class TrustClient {
  readonly #connection: TrustConnection;
  readonly #options: TrustClientOptions;
  constructor(connection: unknown, options: TrustClientOptions = {}) {
    let parsed: TrustConnection;
    try {
      parsed = trustConnectionSchema.parse(connection);
    } catch {
      fail();
    }
    this.#connection = Object.freeze(parsed);
    this.#options = { ...options };
  }
  #current(signal: AbortSignal) {
    if (signal.aborted) fail();
    this.#options.current?.();
  }
  #signal() {
    return AbortSignal.any([
      ...(this.#options.signal ? [this.#options.signal] : []),
      (this.#options.deadline ?? AbortSignal.timeout)(30000),
    ]);
  }
  #scope(pin: TrustPin) {
    if (pin.accountId !== this.#connection.owner || pin.serverOrigin !== this.#connection.origin)
      fail();
  }
  async #json(
    path: '/api/me' | '/api/security/trust/publish' | '/api/security/trust/read',
    signal: AbortSignal,
    body?: unknown,
  ): Promise<unknown> {
    this.#current(signal);
    const text = body === undefined ? undefined : JSON.stringify(body);
    if (text !== undefined && Buffer.byteLength(text) > TRUST_PUBLICATION_LIMITS.wireBytes) fail();
    const url = this.#connection.origin + path;
    const response = await bounded(
      (this.#options.fetch ?? fetch)(url, {
        method: body === undefined ? 'GET' : 'POST',
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        signal,
        headers: {
          Accept: 'application/json',
          Origin: this.#connection.origin,
          Cookie: this.#connection.cookie,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(text === undefined ? {} : { body: text }),
      }),
      signal,
    );
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      this.#current(signal);
      const limit = path === '/api/me' ? 4096 : TRUST_PUBLICATION_LIMITS.wireBytes;
      const length = response.headers.get('content-length');
      if (
        response.redirected ||
        (response.url && response.url !== url) ||
        !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') ||
        (length !== null && (!/^\d+$/.test(length) || Number(length) > limit))
      )
        fail();
      reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader)
        while (true) {
          const chunk = await bounded(reader.read(), signal);
          this.#current(signal);
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > limit) fail();
          chunks.push(chunk.value);
        }
      this.#current(signal);
      const value = JSON.parse(
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)),
      );
      if (!response.ok) fail();
      return value;
    } catch {
      if (reader) void reader.cancel().catch(() => {});
      else void response.body?.cancel().catch(() => {});
      return fail();
    } finally {
      reader?.releaseLock();
    }
  }
  async #identity(pin: TrustPin, signal: AbortSignal) {
    this.#scope(pin);
    const identity = identitySchema.parse(await this.#json('/api/me', signal));
    this.#current(signal);
    if (identity.owner !== this.#connection.owner || identity.needsSetup || identity.localOnly)
      fail();
  }
  async publish(input: {
    pin: TrustPin;
    rootPublicKey: RootPublicJwk;
    entries: PublicTrustEntry[];
  }): Promise<TrustPublishReceipt> {
    try {
      const pin = trustPinSchema.parse(input.pin),
        root = rootPublicJwkSchema.parse(input.rootPublicKey);
      const request = trustPublishSchema.parse({
        publicationVersion: TRUST_PUBLICATION_VERSION,
        entries: input.entries,
      });
      const signal = this.#signal();
      this.#scope(pin);
      this.#current(signal);
      for (const entry of request.entries) {
        if (!same(entry.pin, pin) || !same(entry.rootPublicKey, root)) fail();
        await verifyPublicTrustEntry(entry);
        this.#current(signal);
      }
      await this.#identity(pin, signal);
      const receipt = trustPublishReceiptSchema.parse(
        await this.#json('/api/security/trust/publish', signal, request),
      );
      this.#current(signal);
      if (
        !same(receipt.pin, pin) ||
        !same(receipt.rootPublicKey, root) ||
        !same(
          receipt.stored,
          request.entries.map((entry) => entry.checkpoint),
        )
      )
        fail();
      // This receipt acknowledges public storage, never root authority or the hinted head.
      return receipt;
    } catch {
      return fail();
    }
  }
  async read(input: { request: TrustRead; rootPublicKey: RootPublicJwk }): Promise<TrustPage> {
    try {
      const request = trustReadSchema.parse(input.request),
        root = rootPublicJwkSchema.parse(input.rootPublicKey);
      const signal = this.#signal();
      this.#scope(request.pin);
      this.#current(signal);
      await this.#identity(request.pin, signal);
      const page = trustPageSchema.parse(
        await this.#json('/api/security/trust/read', signal, request),
      );
      this.#current(signal);
      if (
        !same(page.pin, request.pin) ||
        !same(page.rootPublicKey, root) ||
        !same(page.after, request.after) ||
        (request.head && !same(page.head, request.head)) ||
        page.entries.length > request.limit
      )
        fail();
      let previous = request.after ?? undefined;
      for (const raw of page.entries) {
        const entry = publicTrustEntrySchema.parse(raw);
        const trust = await VerifiedTrust.verify({
          signed: entry.signedManifest,
          rootPublicKey: root,
          pin: request.pin,
          previous,
        });
        this.#current(signal);
        if (!same(trust.checkpoint, entry.checkpoint)) fail();
        previous = trust.checkpoint;
      }
      // Only entries have been authenticated. An incomplete page's head is still a relay hint.
      return page;
    } catch {
      return fail();
    }
  }
}
