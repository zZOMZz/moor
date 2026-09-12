import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AppError, assert } from '../protocol';
import { Store, token, hash } from './accounts';
import type { GoogleIdentity, GoogleOidcProvider } from './google-oidc';

const opaque = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const startSchema = z
  .object({
    mode: z.enum(['login', 'setup', 'link']),
    desktop: z.boolean().default(false),
    setupToken: z.string().max(1024).optional(),
    password: z.string().max(1024).optional(),
  })
  .strict();
const proofSchema = z.object({ flowId: opaque, secret: opaque.optional() }).strict();
const CLIENT = 'moor_google_client';
const BROWSER = 'moor_google_browser';
const TTL = 10 * 60 * 1000;
const INVALID = 'Google 登录请求已失效，请重新开始';
type Flow = {
  id: string;
  secretHash: string;
  browserHash?: string;
  code: string;
  mode: 'login' | 'setup' | 'link';
  desktop: boolean;
  owner: string | null;
  loginHash?: string;
  expiresAt: number;
  phase: 'created' | 'authorizing' | 'verifying' | 'review' | 'ready' | 'failed';
  state: string;
  nonce: string;
  verifier: string;
  identity?: GoogleIdentity;
};

/** In-memory authentication attempts intentionally do not survive relay restarts. */
export class GoogleAuth {
  private flows = new Map<string, Flow>();
  private stopped = false;
  private generation = 0;
  private attempts = new Map<string, { until: number; count: number }>();
  private activeStarts = 0;
  private attemptWindow = { until: 0, count: 0 };
  constructor(
    private store: Store,
    private options: {
      origin: string;
      setupToken: string;
      provider?: GoogleOidcProvider;
    },
  ) {}
  get enabled() {
    return !!this.options.provider && !this.stopped;
  }
  close() {
    this.stopped = true;
    this.flows.clear();
  }
  setOrigin(origin: string) {
    this.generation++;
    this.flows.clear();
    this.options.origin = origin;
  }
  private cookie(req: IncomingMessage, name: string) {
    const entries = (req.headers.cookie ?? '')
      .split(';')
      .map((v) => v.trim())
      .filter((v) => v.startsWith(name + '='));
    return entries.length === 1 ? entries[0]!.slice(name.length + 1) : '';
  }
  private setCookie(name: string, value: string, lax = false, maxAge = 600) {
    return `${name}=${value}; Path=/; HttpOnly; SameSite=${lax ? 'Lax' : 'Strict'}; Max-Age=${maxAge}${this.options.origin.startsWith('https:') ? '; Secure' : ''}`;
  }
  private json(res: ServerResponse, value: unknown) {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(value));
  }
  private redirect(res: ServerResponse, location: string) {
    res.writeHead(303, {
      Location: location,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    });
    res.end();
  }
  private async body(req: IncomingMessage) {
    assert(req.headers['content-type']?.startsWith('application/json'), 415, '需要 JSON 请求');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      assert(size <= 4096, 413, '请求过大');
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      throw new AppError(400, 'JSON 无效');
    }
  }
  private current(flow: Flow) {
    assert(
      this.enabled && this.flows.get(flow.id) === flow && flow.expiresAt > this.store.now(),
      401,
      INVALID,
    );
    return flow;
  }
  private loginOwner(req: IncomingMessage): string | null {
    try {
      return this.store.owner(this.cookie(req, 'personal'));
    } catch {
      return null;
    }
  }
  private originalAccount(flow: Flow) {
    this.current(flow);
    if (flow.mode === 'setup') assert(!this.store.hasAccount(), 409, '账号已创建，请重新登录');
    else {
      assert(this.store.hasAccount(), 409, INVALID);
      if (flow.owner)
        assert(
          this.store.db.prepare('SELECT 1 FROM account WHERE id=?').get(flow.owner),
          401,
          INVALID,
        );
    }
    if (flow.loginHash) {
      const row = this.store.db
        .prepare('SELECT owner FROM login WHERE token=? AND expires>?')
        .get(flow.loginHash, this.store.now());
      assert(row && row.owner === flow.owner, 401, '原登录已失效，请重新登录后绑定');
    }
  }
  private proof(req: IncomingMessage, value: unknown) {
    const b = proofSchema.parse(value),
      flow = this.flows.get(b.flowId);
    assert(flow, 401, INVALID);
    this.current(flow);
    const secret = flow.desktop ? (b.secret ?? '') : this.cookie(req, CLIENT);
    assert(hash(secret) === flow.secretHash, 401, INVALID);
    if (!flow.desktop) assert(!b.secret, 400, '浏览器登录需要原页面');
    return flow;
  }
  private browser(req: IncomingMessage) {
    const binding = hash(this.cookie(req, BROWSER));
    const flow = [...this.flows.values()].find((f) => f.browserHash === binding);
    assert(flow, 401, INVALID);
    this.current(flow);
    if (!flow.desktop) assert(hash(this.cookie(req, CLIENT)) === flow.secretHash, 401, INVALID);
    return flow;
  }
  private finish(flow: Flow, res: ServerResponse) {
    this.originalAccount(flow);
    assert(flow.identity, 401, INVALID);
    // Claim before the synchronous account transaction: no retry can issue another login.
    this.flows.delete(flow.id);
    let secret: string;
    if (flow.mode === 'setup') secret = this.store.setupGoogle(flow.identity);
    else if (flow.mode === 'link') {
      this.store.linkGoogle(flow.owner!, flow.identity);
      // Linking keeps the exact original login. Do not mint a new credential on an unrelated browser.
      this.json(res, { ok: true });
      return;
    } else {
      secret = this.store.loginGoogle(flow.identity);
      assert(this.store.owner(secret) === flow.owner, 401, INVALID);
    }
    res.setHeader('Set-Cookie', this.setCookie('personal', secret, false, 2592000));
    this.json(res, { ok: true });
  }
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const limited =
      req.method === 'POST' &&
      ['/api/auth/google/start', '/api/auth/google/unlink'].includes(url.pathname);
    if (!limited) return this.handleRequest(req, res, url);
    assert(this.enabled, 404, 'Google 登录尚未配置');
    assert(req.headers.origin === this.options.origin, 403, '请求来源不匹配');
    const now = this.store.now(),
      key = req.socket.remoteAddress ?? 'unknown';
    for (const [address, value] of this.attempts)
      if (value.until <= now) this.attempts.delete(address);
    if (this.attemptWindow.until <= now) this.attemptWindow = { until: now + 60000, count: 0 };
    const window = this.attempts.get(key) ?? { until: now + 60000, count: 0 };
    assert(
      this.activeStarts < 4 && this.attemptWindow.count < 20 && window.count < 10,
      429,
      '登录尝试过多，请稍后重试',
    );
    // The global window also bounds the number of per-address entries.
    this.attemptWindow.count++;
    window.count++;
    this.attempts.set(key, window);
    this.activeStarts++;
    try {
      return await this.handleRequest(req, res, url);
    } finally {
      this.activeStarts--;
    }
  }
  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> {
    const path = url.pathname;
    if (!path.startsWith('/api/auth/google/') && path !== '/auth/google/start') return false;
    assert(this.enabled, 404, 'Google 登录尚未配置');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // Do not exempt these browser endpoints for a bearer token.
    if (req.method !== 'GET')
      assert(req.headers.origin === this.options.origin, 403, '请求来源不匹配');
    for (const [key, flow] of this.flows)
      if (flow.expiresAt <= this.store.now()) this.flows.delete(key);
    if (path === '/api/auth/google/start' && req.method === 'POST') {
      const generation = this.generation;
      assert(this.flows.size < 64, 429, '登录请求过多，请稍后重试');
      const b = startSchema.parse(await this.body(req));
      const owner = this.loginOwner(req);
      if (b.mode === 'setup') {
        assert(!this.store.hasAccount(), 409, '账号已创建');
        const expected = hash(this.options.setupToken),
          actual = hash(b.setupToken ?? '');
        assert(
          timingSafeEqual(Buffer.from(expected), Buffer.from(actual)),
          403,
          '初始化口令不正确',
        );
      } else {
        assert(this.store.hasAccount(), 409, '请先创建个人账号');
        if (b.mode === 'link') {
          assert(owner, 401, '请先登录');
          await this.store.verifyPassword(owner, b.password ?? '');
          assert(this.loginOwner(req) === owner, 401, '原登录已失效');
          assert(!this.store.googleIdentity(owner), 409, '已绑定 Google 账号');
        } else assert(!owner, 409, '当前已经登录');
      }
      assert(this.enabled && this.generation === generation, 503, INVALID);
      assert(this.flows.size < 64, 429, '登录请求过多，请稍后重试');
      const secret = token(),
        flowId = token();
      const ownerId =
        b.mode === 'setup'
          ? null
          : (owner ??
            (this.store.db.prepare('SELECT id FROM account LIMIT 1').get()!.id as string));
      const flow: Flow = {
        id: flowId,
        secretHash: hash(secret),
        mode: b.mode,
        desktop: b.desktop,
        owner: ownerId,
        ...(b.mode === 'link' ? { loginHash: hash(this.cookie(req, 'personal')) } : {}),
        code: randomBytes(4)
          .toString('hex')
          .toUpperCase()
          .replace(/(.{4})(.{4})/, '$1-$2'),
        expiresAt: this.store.now() + TTL,
        phase: 'created',
        state: token(),
        nonce: token(),
        verifier: token(),
      };
      this.flows.set(flowId, flow);
      if (!b.desktop) res.setHeader('Set-Cookie', this.setCookie(CLIENT, secret));
      this.json(res, {
        flowId,
        ...(b.desktop ? { secret } : {}),
        code: flow.code,
        expiresAt: flow.expiresAt,
        launchPath: '/auth/google/start?flow=' + flowId,
      });
      return true;
    }
    if (path === '/auth/google/start' && req.method === 'GET') {
      assert([...url.searchParams].length === 1 && url.searchParams.has('flow'), 400, INVALID);
      const flow = this.flows.get(opaque.parse(url.searchParams.get('flow')));
      assert(flow, 401, INVALID);
      this.originalAccount(flow);
      assert(flow.phase === 'created', 409, INVALID);
      if (!flow.desktop) assert(hash(this.cookie(req, CLIENT)) === flow.secretHash, 401, INVALID);
      const binding = token();
      flow.browserHash = hash(binding);
      flow.phase = 'authorizing';
      const challenge = createHash('sha256').update(flow.verifier).digest('base64url');
      const destination = this.options.provider!.authorizationUrl({
        state: flow.state,
        nonce: flow.nonce,
        codeChallenge: challenge,
      });
      res.setHeader('Set-Cookie', this.setCookie(BROWSER, binding, true));
      this.redirect(res, destination);
      return true;
    }
    if (path === '/api/auth/google/callback' && req.method === 'GET') {
      // Strict client/login cookies may be absent on this cross-site navigation.
      const binding = hash(this.cookie(req, BROWSER));
      const state = url.searchParams.get('state');
      const flow = [...this.flows.values()].find(
        (f) => f.state === state && f.browserHash === binding,
      );
      assert(flow, 401, INVALID);
      this.originalAccount(flow);
      assert(flow.phase === 'authorizing', 409, INVALID);
      flow.phase = 'verifying';
      try {
        for (const key of ['state', 'code', 'error', 'iss'])
          assert(url.searchParams.getAll(key).length <= 1, 400, INVALID);
        assert(url.searchParams.get('iss') === 'https://accounts.google.com', 401, INVALID);
        const code = url.searchParams.get('code');
        assert(code && code.length <= 4096 && !url.searchParams.has('error'), 401, INVALID);
        const identity = await this.options.provider!.exchangeAndVerify({
          code,
          codeVerifier: flow.verifier,
          nonce: flow.nonce,
        });
        this.originalAccount(flow);
        flow.identity = identity;
        flow.phase = 'review';
      } catch {
        if (this.flows.get(flow.id) === flow) flow.phase = 'failed';
      }
      this.redirect(res, '/auth/google/complete');
      return true;
    }
    if (path === '/api/auth/google/review' && req.method === 'GET') {
      const flow = this.browser(req);
      this.originalAccount(flow);
      assert(flow.phase === 'review' && flow.identity, 401, INVALID);
      this.json(res, {
        flowId: flow.id,
        mode: flow.mode,
        desktop: flow.desktop,
        code: flow.code,
        email: flow.identity.email,
      });
      return true;
    }
    if (path === '/api/auth/google/confirm' && req.method === 'POST') {
      const b = z
        .object({ flowId: opaque })
        .strict()
        .parse(await this.body(req));
      const flow = this.browser(req);
      assert(flow.id === b.flowId, 401, INVALID);
      this.originalAccount(flow);
      assert(flow.phase === 'review' && flow.identity, 409, INVALID);
      if (!flow.desktop) {
        if (flow.mode === 'link')
          assert(
            this.loginOwner(req) === flow.owner &&
              hash(this.cookie(req, 'personal')) === flow.loginHash,
            401,
            INVALID,
          );
        else assert(!this.loginOwner(req), 409, '当前已经登录，请重新开始');
        this.finish(flow, res);
      } else {
        flow.phase = 'ready';
        this.json(res, { ok: true });
      }
      return true;
    }
    if (path === '/api/auth/google/desktop/review' && req.method === 'POST') {
      const flow = this.proof(req, await this.body(req));
      this.originalAccount(flow);
      assert(flow.desktop && flow.phase !== 'failed', 401, INVALID);
      this.json(res, {
        status: flow.phase === 'ready' ? 'ready' : 'pending',
        mode: flow.mode,
        ...(flow.phase === 'ready' ? { email: flow.identity!.email } : {}),
      });
      return true;
    }
    if (path === '/api/auth/google/desktop/finish' && req.method === 'POST') {
      const flow = this.proof(req, await this.body(req));
      this.originalAccount(flow);
      assert(flow.desktop && flow.phase === 'ready', 409, '请先在系统浏览器确认登录');
      // Changing or signing out of the originating client invalidates a link.
      if (flow.mode === 'link')
        assert(
          this.loginOwner(req) === flow.owner &&
            hash(this.cookie(req, 'personal')) === flow.loginHash,
          401,
          INVALID,
        );
      else assert(!this.loginOwner(req), 409, '当前已经登录，请重新开始');
      this.finish(flow, res);
      return true;
    }
    if (path === '/api/auth/google/cancel' && req.method === 'POST') {
      const flow = this.proof(req, await this.body(req));
      this.flows.delete(flow.id);
      this.json(res, { ok: true });
      return true;
    }
    if (path === '/api/auth/google/unlink' && req.method === 'POST') {
      const b = z
        .object({ password: z.string().max(1024) })
        .strict()
        .parse(await this.body(req));
      const owner = this.loginOwner(req);
      assert(owner, 401, '请先登录');
      await this.store.verifyPassword(owner, b.password);
      assert(this.loginOwner(req) === owner && this.enabled, 401, INVALID);
      this.store.unlinkGoogle(owner);
      for (const [id, flow] of this.flows) if (flow.owner === owner) this.flows.delete(id);
      this.json(res, { ok: true });
      return true;
    }
    throw new AppError(404, '未找到');
  }
}
