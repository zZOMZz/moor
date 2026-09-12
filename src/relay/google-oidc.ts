import { timingSafeEqual } from 'node:crypto';
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet, type JWK } from 'jose';

export const GOOGLE_ISSUER = 'https://accounts.google.com' as const;
export const GOOGLE_OIDC_FAILED = 'Google 登录验证失败，请重新开始登录';
const AUTHORIZATION_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_TOKEN_BYTES = 16_384;
const MAX_TOKEN_RESPONSE_BYTES = 65_536;
const MAX_JWKS_BYTES = 262_144;
const JWKS_REFRESH_COOLDOWN_MS = 30_000;
const JWKS_MAX_AGE_MS = 86_400_000;

export type GoogleIdentity = {
  issuer: typeof GOOGLE_ISSUER;
  subject: string;
  email: string;
  emailVerified: true;
};
export type GoogleOidcProvider = {
  authorizationUrl(input: { state: string; nonce: string; codeChallenge: string }): string;
  exchangeAndVerify(input: {
    code: string;
    codeVerifier: string;
    nonce: string;
  }): Promise<GoogleIdentity>;
};
export type GoogleOidcConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};
export type GoogleOidcDependencies = {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  scheduleTimeout?: (callback: () => void, timeoutMs: number) => () => void;
};

const failed = () => new Error(GOOGLE_OIDC_FAILED);
function check(condition: unknown): asserts condition {
  if (!condition) throw failed();
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function ascii(value: unknown, min: number, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.length >= min &&
    value.length <= max &&
    /^[\x21-\x7e]+$/.test(value)
  );
}
const flowValue = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{32,256}$/.test(value);

function cacheAge(headers: Headers) {
  const control = headers.get('cache-control') ?? '';
  if (/(?:^|,)\s*(?:no-cache|no-store)(?:\s|=|,|$)/i.test(control)) return 0;
  const match = /(?:^|,)\s*max-age\s*=\s*"?(\d+)"?\s*(?:,|$)/i.exec(control);
  const age = Number(headers.get('age') ?? '0');
  if (!match || !Number.isSafeInteger(age) || age < 0) return 0;
  return Math.max(0, Math.min(JWKS_MAX_AGE_MS, (Number(match[1]) - age) * 1000));
}

function publicKeys(value: unknown): JSONWebKeySet {
  check(record(value) && Array.isArray(value.keys));
  check(value.keys.length > 0 && value.keys.length <= 32);
  const seen = new Set<string>();
  const keys: JWK[] = value.keys.map((key: unknown) => {
    check(record(key) && key.kty === 'RSA' && ascii(key.kid, 1, 256));
    check(!seen.has(key.kid));
    seen.add(key.kid);
    check(typeof key.n === 'string' && /^[A-Za-z0-9_-]{256,2048}$/.test(key.n));
    check(typeof key.e === 'string' && /^[A-Za-z0-9_-]{1,16}$/.test(key.e));
    check(key.alg === undefined || key.alg === 'RS256');
    check(key.use === undefined || key.use === 'sig');
    check(
      key.key_ops === undefined ||
        (Array.isArray(key.key_ops) && key.key_ops.length === 1 && key.key_ops[0] === 'verify'),
    );
    check(['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth'].every((name) => key[name] === undefined));
    // Only public verification material is handed to jose; no token-provided URLs are read.
    return { kty: 'RSA', kid: key.kid, n: key.n, e: key.e, alg: 'RS256', use: 'sig' };
  });
  return { keys };
}

/**
 * Google Web-client authorization code flow, with no account or browser-session state.
 * The caller owns one-use state/nonce/PKCE storage and explicit account binding.
 * Endpoints and RS256/S256 are pinned to Google's published discovery metadata:
 * https://accounts.google.com/.well-known/openid-configuration
 */
export function createGoogleOidcProvider(
  config: GoogleOidcConfig,
  dependencies: GoogleOidcDependencies = {},
): GoogleOidcProvider {
  let redirect: URL;
  try {
    check(ascii(config.clientId, 1, 1024) && ascii(config.clientSecret, 1, 4096));
    check(typeof config.redirectUri === 'string' && config.redirectUri.length <= 4096);
    redirect = new URL(config.redirectUri);
    check(
      (redirect.protocol === 'https:' ||
        (redirect.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname))) &&
        !redirect.username &&
        !redirect.password &&
        !redirect.search &&
        !redirect.hash &&
        redirect.href === config.redirectUri,
    );
  } catch {
    throw failed();
  }
  // Copy configuration so a caller cannot change the client or redirect during an exchange.
  const { clientId, clientSecret } = config;
  const redirectUri = redirect.href;
  const fetch = dependencies.fetch ?? globalThis.fetch;
  const now = dependencies.now ?? Date.now;
  const schedule =
    dependencies.scheduleTimeout ??
    ((callback: () => void, timeoutMs: number) => {
      const timer = setTimeout(callback, timeoutMs);
      timer.unref();
      return () => clearTimeout(timer);
    });

  async function requestJson(url: string, init: RequestInit, maxBytes: number) {
    const controller = new AbortController();
    let cancelTimeout = () => {};
    let response: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      cancelTimeout = schedule(() => {
        controller.abort();
        reject(failed());
      }, REQUEST_TIMEOUT_MS);
    });
    const read = async () => {
      let complete = false;
      try {
        response = await fetch(url, { ...init, redirect: 'error', signal: controller.signal });
        check(!controller.signal.aborted);
        check(response.status === 200 && !response.redirected);
        check(/^application\/json(?:\s*;|\s*$)/i.test(response.headers.get('content-type') ?? ''));
        const length = response.headers.get('content-length');
        check(length === null || (/^\d+$/.test(length) && Number(length) <= maxBytes));
        check(response.body);
        reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        while (true) {
          check(!controller.signal.aborted);
          const chunk = await reader.read();
          check(!controller.signal.aborted);
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          check(bytes <= maxBytes);
          chunks.push(chunk.value);
        }
        const value: unknown = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
        );
        check(record(value));
        complete = true;
        return { value, headers: response.headers };
      } finally {
        if (!complete) {
          if (reader) void reader.cancel().catch(() => {});
          else if (response?.body) void response.body.cancel().catch(() => {});
        }
      }
    };
    try {
      return await Promise.race([read(), timeout]);
    } finally {
      cancelTimeout();
      controller.abort();
      if (reader) void reader.cancel().catch(() => {});
    }
  }

  type Keys = {
    resolve: ReturnType<typeof createLocalJWKSet>;
    ids: Set<string>;
    expires: number;
  };
  let cached: Keys | undefined;
  let refreshing: Promise<Keys> | undefined;
  let lastRefresh = -Infinity;
  async function refresh() {
    if (refreshing) return refreshing;
    lastRefresh = now();
    refreshing = (async () => {
      const result = await requestJson(
        JWKS_URL,
        { headers: { Accept: 'application/json' } },
        MAX_JWKS_BYTES,
      );
      const keys = publicKeys(result.value);
      cached = {
        resolve: createLocalJWKSet(keys),
        ids: new Set(keys.keys.map((key) => key.kid!)),
        expires: now() + cacheAge(result.headers),
      };
      return cached;
    })();
    try {
      return await refreshing;
    } finally {
      refreshing = undefined;
    }
  }
  async function keysFor(kid: string) {
    const fresh = cached && cached.expires > now();
    let keys = fresh ? cached! : await refresh();
    if (keys.ids.has(kid)) return keys.resolve;
    // A new kid may require rotation before max-age expires. Deduplicate and rate-limit
    // that refresh; a just-fetched set that still lacks the key is never fetched twice.
    check(fresh && (refreshing || now() - lastRefresh >= JWKS_REFRESH_COOLDOWN_MS));
    keys = await refresh();
    check(keys.ids.has(kid));
    return keys.resolve;
  }

  return {
    authorizationUrl(input) {
      try {
        check(flowValue(input.state) && flowValue(input.nonce));
        check(
          typeof input.codeChallenge === 'string' &&
            /^[A-Za-z0-9_-]{43}$/.test(input.codeChallenge),
        );
        const url = new URL(AUTHORIZATION_URL);
        url.search = new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: 'openid email',
          state: input.state,
          nonce: input.nonce,
          code_challenge: input.codeChallenge,
          code_challenge_method: 'S256',
          prompt: 'select_account',
        }).toString();
        return url.href;
      } catch {
        throw failed();
      }
    },
    async exchangeAndVerify(input) {
      try {
        const { code, codeVerifier, nonce } = input;
        check(ascii(code, 1, 4096) && flowValue(nonce));
        check(typeof codeVerifier === 'string' && /^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier));
        const result = await requestJson(
          TOKEN_URL,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              Accept: 'application/json',
            },
            body: new URLSearchParams({
              grant_type: 'authorization_code',
              client_id: clientId,
              client_secret: clientSecret,
              redirect_uri: redirectUri,
              code,
              code_verifier: codeVerifier,
            }).toString(),
          },
          MAX_TOKEN_RESPONSE_BYTES,
        );
        const idToken = result.value.id_token;
        check(ascii(idToken, 1, MAX_TOKEN_BYTES));
        const { payload } = await jwtVerify(
          idToken,
          async (header, token) => {
            check(header.alg === 'RS256' && ascii(header.kid, 1, 256));
            check(header.jku === undefined && header.jwk === undefined && header.x5u === undefined);
            return (await keysFor(header.kid))(header, token);
          },
          {
            algorithms: ['RS256'],
            issuer: [GOOGLE_ISSUER, 'accounts.google.com'],
            audience: clientId,
            requiredClaims: ['iss', 'sub', 'aud', 'exp', 'iat', 'nonce', 'email', 'email_verified'],
            currentDate: new Date(now()),
            clockTolerance: 30,
            maxTokenAge: 600,
          },
        );
        check(
          payload.aud === clientId ||
            (Array.isArray(payload.aud) && payload.aud.length === 1 && payload.aud[0] === clientId),
        );
        check(payload.azp === undefined || payload.azp === clientId);
        check(Number.isSafeInteger(payload.exp) && payload.exp! > Math.floor(now() / 1000));
        check(Number.isSafeInteger(payload.iat));
        check(
          flowValue(payload.nonce) &&
            timingSafeEqual(Buffer.from(payload.nonce), Buffer.from(nonce)),
        );
        check(ascii(payload.sub, 1, 255));
        check(
          typeof payload.email === 'string' &&
            payload.email.length <= 320 &&
            /^[^\s@\x00-\x1f\x7f]+@[^\s@\x00-\x1f\x7f]+$/.test(payload.email) &&
            payload.email_verified === true,
        );
        return {
          issuer: GOOGLE_ISSUER,
          subject: payload.sub,
          email: payload.email,
          emailVerified: true,
        };
      } catch {
        // Never forward OAuth response bodies, bearer tokens, secrets, or JWT diagnostics.
        throw failed();
      }
    },
  };
}
