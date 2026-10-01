import { z } from 'zod';
import { assert } from '@moor/protocol/protocol';
import { utf8 } from '@moor/protocol/binary';
import type { Accounts } from '../accounts/service';
import type { CredentialPort, ExternalIdentity } from '../accounts/ports';
export const GOOGLE_ISSUER = 'https://accounts.google.com' as const;
export type GoogleIdentity = ExternalIdentity;
export interface GoogleOidcProvider {
  authorizationUrl(input: { state: string; nonce: string; codeChallenge: string }): string;
  exchangeAndVerify(input: {
    code: string;
    codeVerifier: string;
    nonce: string;
  }): Promise<GoogleIdentity>;
}
export type GoogleClientProof = { personal: string; client: string; browser: string };
export type GoogleCompletion = { loginSecret?: string };
export interface GoogleEntropy extends Pick<CredentialPort, 'token' | 'hash' | 'equal'> {
  confirmationCode(): string;
  challenge(verifier: string): string;
}
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
export class GoogleLogin {
  private flows = new Map<string, Flow>();
  private stopped = false;
  private generation = 0;
  private attempts = new Map<string, { until: number; count: number }>();
  private activeStarts = 0;
  private attemptWindow = { until: 0, count: 0 };
  constructor(
    private readonly accounts: Pick<
      Accounts,
      | 'now'
      | 'hasAccount'
      | 'hasOwner'
      | 'loginOwner'
      | 'firstOwner'
      | 'owner'
      | 'setupGoogle'
      | 'linkGoogle'
      | 'loginGoogle'
      | 'verifyPassword'
      | 'googleIdentity'
      | 'unlinkGoogle'
    >,
    private readonly entropy: GoogleEntropy,
    private readonly options: { setupToken: string; provider?: GoogleOidcProvider },
  ) {}
  get originVersion() {
    return this.generation;
  }
  get enabled() {
    return !!this.options.provider && !this.stopped;
  }
  close() {
    this.stopped = true;
    this.flows.clear();
  }
  invalidateOrigin() {
    this.generation++;
    this.flows.clear();
  }
  private prune() {
    assert(this.enabled, 404, 'Google 登录尚未配置');
    for (const [id, flow] of this.flows)
      if (flow.expiresAt <= this.accounts.now()) this.flows.delete(id);
  }
  private current(flow: Flow) {
    assert(
      this.enabled && this.flows.get(flow.id) === flow && flow.expiresAt > this.accounts.now(),
      401,
      INVALID,
    );
    return flow;
  }
  private loginOwner(proof: GoogleClientProof): string | null {
    try {
      return this.accounts.owner(proof.personal);
    } catch {
      return null;
    }
  }
  private originalAccount(flow: Flow) {
    this.current(flow);
    if (flow.mode === 'setup') assert(!this.accounts.hasAccount(), 409, '账号已创建，请重新登录');
    else {
      assert(this.accounts.hasAccount(), 409, INVALID);
      if (flow.owner) assert(this.accounts.hasOwner(flow.owner), 401, INVALID);
    }
    if (flow.loginHash)
      assert(
        this.accounts.loginOwner(flow.loginHash) === flow.owner,
        401,
        '原登录已失效，请重新登录后绑定',
      );
  }
  private proof(proof: GoogleClientProof, input: unknown) {
    const value = proofSchema.parse(input),
      flow = this.flows.get(value.flowId);
    assert(flow, 401, INVALID);
    this.current(flow);
    const secret = flow.desktop ? (value.secret ?? '') : proof.client;
    assert(this.entropy.hash(secret) === flow.secretHash, 401, INVALID);
    if (!flow.desktop) assert(!value.secret, 400, '浏览器登录需要原页面');
    return flow;
  }
  private browser(proof: GoogleClientProof) {
    const binding = this.entropy.hash(proof.browser),
      flow = [...this.flows.values()].find((f) => f.browserHash === binding);
    assert(flow, 401, INVALID);
    this.current(flow);
    if (!flow.desktop) assert(this.entropy.hash(proof.client) === flow.secretHash, 401, INVALID);
    return flow;
  }
  private finish(flow: Flow): GoogleCompletion {
    this.originalAccount(flow);
    assert(flow.identity, 401, INVALID);
    this.flows.delete(flow.id);
    if (flow.mode === 'link') {
      this.accounts.linkGoogle(flow.owner!, flow.identity);
      return {};
    }
    const loginSecret =
      flow.mode === 'setup'
        ? this.accounts.setupGoogle(flow.identity)
        : this.accounts.loginGoogle(flow.identity);
    if (flow.mode === 'login')
      assert(this.accounts.owner(loginSecret) === flow.owner, 401, INVALID);
    return { loginSecret };
  }
  async limited<T>(key: string, work: () => Promise<T>): Promise<T> {
    assert(this.enabled, 404, 'Google 登录尚未配置');
    const now = this.accounts.now();
    for (const [address, value] of this.attempts)
      if (value.until <= now) this.attempts.delete(address);
    if (this.attemptWindow.until <= now) this.attemptWindow = { until: now + 60000, count: 0 };
    const window = this.attempts.get(key) ?? { until: now + 60000, count: 0 };
    assert(
      this.activeStarts < 4 && this.attemptWindow.count < 20 && window.count < 10,
      429,
      '登录尝试过多，请稍后重试',
    );
    this.attemptWindow.count++;
    window.count++;
    this.attempts.set(key, window);
    this.activeStarts++;
    try {
      return await work();
    } finally {
      this.activeStarts--;
    }
  }
  async start(input: unknown, proof: GoogleClientProof, generation: number) {
    this.prune();
    assert(this.flows.size < 64, 429, '登录请求过多，请稍后重试');
    const value = startSchema.parse(input),
      owner = this.loginOwner(proof);
    if (value.mode === 'setup') {
      assert(!this.accounts.hasAccount(), 409, '账号已创建');
      assert(
        this.entropy.equal(
          utf8(this.entropy.hash(this.options.setupToken)),
          utf8(this.entropy.hash(value.setupToken ?? '')),
        ),
        403,
        '初始化口令不正确',
      );
    } else {
      assert(this.accounts.hasAccount(), 409, '请先创建个人账号');
      if (value.mode === 'link') {
        assert(owner, 401, '请先登录');
        await this.accounts.verifyPassword(owner, value.password ?? '');
        assert(this.loginOwner(proof) === owner, 401, '原登录已失效');
        assert(!this.accounts.googleIdentity(owner), 409, '已绑定 Google 账号');
      } else assert(!owner, 409, '当前已经登录');
    }
    assert(this.enabled && this.generation === generation, 503, INVALID);
    assert(this.flows.size < 64, 429, '登录请求过多，请稍后重试');
    const secret = this.entropy.token(),
      flowId = this.entropy.token();
    const flow: Flow = {
      id: flowId,
      secretHash: this.entropy.hash(secret),
      mode: value.mode,
      desktop: value.desktop,
      owner: value.mode === 'setup' ? null : (owner ?? this.accounts.firstOwner()!),
      ...(value.mode === 'link' ? { loginHash: this.entropy.hash(proof.personal) } : {}),
      code: this.entropy.confirmationCode(),
      expiresAt: this.accounts.now() + TTL,
      phase: 'created',
      state: this.entropy.token(),
      nonce: this.entropy.token(),
      verifier: this.entropy.token(),
    };
    this.flows.set(flow.id, flow);
    return { flowId, desktop: value.desktop, secret, code: flow.code, expiresAt: flow.expiresAt };
  }
  launch(id: unknown, proof: GoogleClientProof) {
    this.prune();
    const flow = this.flows.get(opaque.parse(id));
    assert(flow, 401, INVALID);
    this.originalAccount(flow);
    assert(flow.phase === 'created', 409, INVALID);
    if (!flow.desktop) assert(this.entropy.hash(proof.client) === flow.secretHash, 401, INVALID);
    const browserSecret = this.entropy.token();
    flow.browserHash = this.entropy.hash(browserSecret);
    flow.phase = 'authorizing';
    const destination = this.options.provider!.authorizationUrl({
      state: flow.state,
      nonce: flow.nonce,
      codeChallenge: this.entropy.challenge(flow.verifier),
    });
    return { browserSecret, destination };
  }
  async callback(
    input: { state: string | null; issuer: string | null; code: string | null; error: boolean },
    proof: GoogleClientProof,
  ) {
    this.prune();
    const binding = this.entropy.hash(proof.browser),
      flow = [...this.flows.values()].find(
        (f) => f.state === input.state && f.browserHash === binding,
      );
    assert(flow, 401, INVALID);
    this.originalAccount(flow);
    assert(flow.phase === 'authorizing', 409, INVALID);
    flow.phase = 'verifying';
    try {
      assert(input.issuer === GOOGLE_ISSUER, 401, INVALID);
      assert(input.code && input.code.length <= 4096 && !input.error, 401, INVALID);
      const identity = await this.options.provider!.exchangeAndVerify({
        code: input.code,
        codeVerifier: flow.verifier,
        nonce: flow.nonce,
      });
      this.originalAccount(flow);
      flow.identity = identity;
      flow.phase = 'review';
    } catch {
      if (this.flows.get(flow.id) === flow) flow.phase = 'failed';
    }
  }
  review(proof: GoogleClientProof) {
    this.prune();
    const flow = this.browser(proof);
    this.originalAccount(flow);
    assert(flow.phase === 'review' && flow.identity, 401, INVALID);
    return {
      flowId: flow.id,
      mode: flow.mode,
      desktop: flow.desktop,
      code: flow.code,
      email: flow.identity.email,
    };
  }
  confirm(input: unknown, proof: GoogleClientProof): GoogleCompletion {
    this.prune();
    const value = z.object({ flowId: opaque }).strict().parse(input),
      flow = this.browser(proof);
    assert(flow.id === value.flowId, 401, INVALID);
    this.originalAccount(flow);
    assert(flow.phase === 'review' && flow.identity, 409, INVALID);
    if (flow.desktop) {
      flow.phase = 'ready';
      return {};
    }
    if (flow.mode === 'link')
      assert(
        this.loginOwner(proof) === flow.owner &&
          this.entropy.hash(proof.personal) === flow.loginHash,
        401,
        INVALID,
      );
    else assert(!this.loginOwner(proof), 409, '当前已经登录，请重新开始');
    return this.finish(flow);
  }
  desktopReview(input: unknown, proof: GoogleClientProof) {
    this.prune();
    const flow = this.proof(proof, input);
    this.originalAccount(flow);
    assert(flow.desktop && flow.phase !== 'failed', 401, INVALID);
    return {
      status: flow.phase === 'ready' ? 'ready' : 'pending',
      mode: flow.mode,
      ...(flow.phase === 'ready' ? { email: flow.identity!.email } : {}),
    };
  }
  desktopFinish(input: unknown, proof: GoogleClientProof): GoogleCompletion {
    this.prune();
    const flow = this.proof(proof, input);
    this.originalAccount(flow);
    assert(flow.desktop && flow.phase === 'ready', 409, '请先在系统浏览器确认登录');
    if (flow.mode === 'link')
      assert(
        this.loginOwner(proof) === flow.owner &&
          this.entropy.hash(proof.personal) === flow.loginHash,
        401,
        INVALID,
      );
    else assert(!this.loginOwner(proof), 409, '当前已经登录，请重新开始');
    return this.finish(flow);
  }
  cancel(input: unknown, proof: GoogleClientProof) {
    this.prune();
    const flow = this.proof(proof, input);
    this.flows.delete(flow.id);
  }
  async unlink(input: unknown, proof: GoogleClientProof) {
    this.prune();
    const value = z
        .object({ password: z.string().max(1024) })
        .strict()
        .parse(input),
      owner = this.loginOwner(proof);
    assert(owner, 401, '请先登录');
    await this.accounts.verifyPassword(owner, value.password);
    assert(this.loginOwner(proof) === owner && this.enabled, 401, INVALID);
    this.accounts.unlinkGoogle(owner);
    for (const [id, flow] of this.flows) if (flow.owner === owner) this.flows.delete(id);
  }
}
