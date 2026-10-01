import { deviceMetadataSchema, type DeviceMetadata } from '@moor/protocol/device-metadata';
import { assert, type RuntimeWorkspace } from '@moor/protocol/protocol';
import { sameValue as isDeepStrictEqual } from '@moor/protocol/value-equality';
import { z } from 'zod';
import type {
  Account,
  AccountsCatalog,
  AccountsRecords,
  CredentialPort,
  Device,
  ExternalIdentity as GoogleIdentity,
} from './ports';
const hasStoredPassword = (
  row: Account | undefined,
): row is Account & {
  salt: string;
  password: Uint8Array;
} =>
  typeof row?.salt === 'string' &&
  row.salt.length > 0 &&
  row.salt.length <= 1024 &&
  row.password instanceof Uint8Array &&
  row.password.byteLength === 64;
const samePassword = (
  a: Account | undefined,
  b: Account | undefined,
  equal: CredentialPort['equal'],
) =>
  hasStoredPassword(a) &&
  hasStoredPassword(b) &&
  a.id === b.id &&
  a.email === b.email &&
  a.salt === b.salt &&
  equal(a.password, b.password);
function assertGoogleIdentity(identity: GoogleIdentity) {
  assert(
    identity?.issuer === 'https://accounts.google.com' &&
      typeof identity.subject === 'string' &&
      /^[\x21-\x7e]{1,255}$/.test(identity.subject) &&
      identity.emailVerified === true &&
      typeof identity.email === 'string' &&
      identity.email.length <= 320 &&
      /^[^\s\x00-\x1f\x7f@]+@[^\s\x00-\x1f\x7f@]+$/.test(identity.email),
    401,
    'Google 身份未能确认，请重新登录',
  );
}
export class Accounts {
  constructor(
    private readonly records: AccountsRecords,
    private readonly credentials: CredentialPort,
    public readonly catalog: AccountsCatalog,
    readonly authorityId: string,
    public readonly now: () => number,
  ) {}

  close() {
    this.records.close();
  }
  snapshot<T>(name: 'replica' | 'catalog' | 'logout', work: () => T): T {
    return this.records.snapshot(name, work);
  }
  clearLogins() {
    this.records.clearLogins();
  }
  hasOwner(owner: string) {
    return !!this.records.account(owner);
  }
  firstOwner() {
    return this.records.firstAccounts()[0]?.id;
  }
  loginOwner(loginHash: string) {
    return this.records.loginOwner(loginHash, this.now());
  }
  hasAccount() {
    return Boolean(this.records.anyAccount());
  }
  private account(owner: string) {
    return this.records.account(owner) as Account | undefined;
  }
  private transaction<T>(work: () => T): T {
    return this.records.atomic(work);
  }
  private samePassword(a: Account | undefined, b: Account | undefined) {
    return samePassword(a, b, this.credentials.equal);
  }
  hasPassword(owner: string) {
    return hasStoredPassword(this.account(owner));
  }
  private async checkPassword(row: Account | undefined, password: string) {
    const validInput = typeof password === 'string' && password.length <= 1024;
    const key = await this.credentials.derive(
      validInput ? password : '',
      hasStoredPassword(row) ? row.salt : 'invalid-login-salt',
    );
    const matches = this.credentials.equal(
      key,
      hasStoredPassword(row) ? row.password : new Uint8Array(64),
    );
    assert(validInput && hasStoredPassword(row) && matches, 401, '邮箱或密码错误');
    assert(this.samePassword(row, this.account(row.id)), 401, '邮箱或密码错误');
  }
  async verifyPassword(owner: string, password: string): Promise<void> {
    const row = this.account(owner);
    await this.checkPassword(row, password);
    assert(this.samePassword(row, this.account(owner)), 401, '邮箱或密码错误');
  }
  async setup(email: string, password: string, owner = this.credentials.uuid() as string) {
    assert(!this.hasAccount(), 409, '账号已创建');
    assert(password.length >= 12 && password.length <= 1024, 400, '密码需要至少 12 个字符');
    const salt = this.credentials.token();
    const key = await this.credentials.derive(password, salt);
    return this.transaction(() => {
      assert(!this.hasAccount(), 409, '账号已创建');
      this.records.insertAccount({
        id: owner,
        email: email.toLowerCase(),
        salt: salt,
        password: key,
      });
      return this.createLogin(owner);
    });
  }
  async login(email: string, password: string) {
    const row = this.records.accountByEmail(email.toLowerCase()) as Account | undefined;
    await this.checkPassword(row, password);
    assert(row && this.samePassword(row, this.account(row.id)), 401, '邮箱或密码错误');
    return this.createLogin(row.id);
  }
  inviteAccount(owner: string) {
    assert(this.account(owner), 401, '请先登录');
    this.records.pruneInvitations(this.now());
    const count = Number({ n: this.records.invitationCount(owner) }!.n);
    assert(count < 20, 429, '尚有过多有效邀请，请等待过期后再创建');
    const secret = this.credentials.token(),
      expiresAt = this.now() + 24 * 60 * 60 * 1000;
    this.records.invite(this.credentials.hash(secret), owner, expiresAt);
    return { invitation: secret, expiresAt };
  }
  async redeemAccountInvitation(invitation: string, email: string, password: string) {
    const current = () => {
      const invite = this.records.invitation(this.credentials.hash(invitation), this.now());
      assert(invite && this.account(String(invite.creator)), 403, '账号邀请无效或已过期');
      assert(!this.records.accountByEmail(email.toLowerCase()), 409, '该账号已存在，请直接登录');
    };
    current();
    assert(password.length >= 12 && password.length <= 1024, 400, '密码需要至少 12 个字符');
    const salt = this.credentials.token(),
      key = await this.credentials.derive(password, salt);
    return this.transaction(() => {
      current();
      const owner = this.credentials.uuid();
      this.records.insertAccount({
        id: owner,
        email: email.toLowerCase(),
        salt: salt,
        password: key,
      });
      this.records.removeInvitation(this.credentials.hash(invitation));
      return this.createLogin(owner);
    });
  }
  googleIdentity(owner: string): { email: string } | null {
    const row = this.records.google(owner);
    return row ?? null;
  }
  private insertGoogle(owner: string, identity: GoogleIdentity) {
    assert(this.account(owner), 404, '账号不存在');
    assert(
      !this.records.google(owner) && !this.records.googleOwner(identity.issuer, identity.subject),
      409,
      'Google 账号已关联，请先核对当前账号',
    );
    const now = this.now();
    this.records.insertGoogle(owner, identity, now);
  }
  setupGoogle(identity: GoogleIdentity, owner = this.credentials.uuid() as string): string {
    assertGoogleIdentity(identity);
    return this.transaction(() => {
      assert(!this.hasAccount(), 409, '账号已创建');
      this.records.insertAccount({
        id: owner,
        email: identity.email.toLowerCase(),
        salt: null,
        password: null,
      });
      this.insertGoogle(owner, identity);
      return this.createLogin(owner);
    });
  }
  linkGoogle(owner: string, identity: GoogleIdentity): void {
    assertGoogleIdentity(identity);
    this.transaction(() => this.insertGoogle(owner, identity));
  }
  loginGoogle(identity: GoogleIdentity): string {
    assertGoogleIdentity(identity);
    return this.transaction(() => {
      const row = ((id) => (id ? { id } : undefined))(
        this.records.googleOwner(identity.issuer, identity.subject),
      );
      assert(row, 401, 'Google 账号尚未关联，请使用原登录方式');
      this.records.updateGoogle(String(row.id), identity.email, this.now());
      return this.createLogin(String(row.id));
    });
  }
  unlinkGoogle(owner: string): void {
    this.transaction(() => {
      assert(this.hasPassword(owner), 409, '请先设置可用的本地密码，才能解除 Google 关联');
      assert(this.googleIdentity(owner), 404, 'Google 账号尚未关联');
      this.records.unlinkGoogle(owner);
    });
  }
  /** Private operator recovery only. Never expose this method through an HTTP route. */
  async resetPassword(email: string, password: string): Promise<void> {
    assert(z.string().email().max(200).safeParse(email).success, 400, '登录邮箱无效');
    assert(
      typeof password === 'string' && password.length >= 12 && password.length <= 1024,
      400,
      '密码需要至少 12 个字符',
    );
    const accounts = this.records.firstAccounts() as Account[];
    assert(accounts.length === 1, 409, '恢复密码需要已有的唯一个人账号');
    const before = accounts[0]!;
    const salt = this.credentials.token(),
      key = await this.credentials.derive(password, salt);
    this.transaction(() => {
      const current = this.records.firstAccounts() as Account[];
      assert(
        current.length === 1 && isDeepStrictEqual(current[0], before),
        409,
        '账号已改变，请重新执行密码恢复',
      );
      this.records.password(before.id, email.toLowerCase(), salt, key);
      this.records.clearLogins();
      this.records.clearPairs();
    });
  }
  createLogin(owner: string) {
    const secret = this.credentials.token();
    this.records.login(this.credentials.hash(secret), owner, this.now() + 30 * 86400000);
    return secret;
  }
  owner(secret: string) {
    const r = ((owner) => (owner ? { owner } : undefined))(
      this.records.loginOwner(this.credentials.hash(secret), this.now()),
    ) as any;
    assert(r, 401, '请先登录');
    return r.owner as string;
  }
  logout(secret: string) {
    this.records.removeLogin(this.credentials.hash(secret));
  }
  pair(owner: string, workspaceId?: string) {
    if (workspaceId) this.catalog.workspace(owner, workspaceId);
    const code = this.credentials.token(12);
    this.records.pair(this.credentials.hash(code), owner, this.now() + 300000, workspaceId ?? null);
    return code;
  }
  redeem(code: string, name: string, id = this.credentials.uuid() as string) {
    const pair = this.records.pairing(this.credentials.hash(code), this.now()) as any;
    assert(pair, 401, '配对码已失效');
    const secret = this.credentials.token();
    this.transaction(() => {
      this.records.removePair(this.credentials.hash(code));
      this.records.insertDevice(
        id,
        pair.owner,
        name,
        this.credentials.hash(secret),
        pair.workspace_id ?? null,
      );
    });
    return { id, token: secret, authorityId: this.authorityId, accountId: String(pair.owner) };
  }
  deviceToken(secret: string) {
    const d = this.records.deviceByToken(this.credentials.hash(secret)) as Device;
    assert(d, 401, '设备凭证无效或已撤销');
    return d;
  }
  device(owner: string, id: string) {
    const d = this.records.device(owner, id) as Device;
    assert(d, 404, '设备不可用');
    return d;
  }
  devices(owner: string) {
    return this.records.devices(owner);
  }
  revoke(owner: string, id: string) {
    this.device(owner, id);
    this.records.revokeDevice(id);
  }
  localDevice(owner: string, name: string) {
    const id = 'local-machine',
      secret = this.credentials.token();
    this.records.localDevice(id, owner, name, this.credentials.hash(secret));
    return { id, token: secret };
  }
  bind(d: Device, machineId: string, workspaces: RuntimeWorkspace[], metadata?: DeviceMetadata) {
    const incoming = metadata === undefined ? undefined : deviceMetadataSchema.parse(metadata);
    return this.transaction(() => {
      const current = this.device(d.owner, d.id);
      assert(
        !current.machine_id || current.machine_id === machineId,
        409,
        '该配对已绑定另一台机器',
      );
      assert(
        workspaces.every((w) => w.machineId === machineId),
        400,
        '工作区执行机器不匹配',
      );
      const revision = Number(current.name_revision ?? 0);
      if (incoming?.revision === revision)
        assert(incoming.name === current.name, 409, '同一电脑名称版本的内容不一致');
      // Old snapshots can restore presence but cannot roll back display metadata.
      if (incoming && incoming.revision > revision)
        this.records.renameDevice(d.id, incoming.name, incoming.revision);
      this.records.bindDevice(d.id, machineId);
      this.catalog.discover(d.owner, d.id, workspaces);
      const saved = this.device(d.owner, d.id);
      return saved.name_revision
        ? deviceMetadataSchema.parse({
            version: 1,
            name: saved.name,
            revision: saved.name_revision,
          })
        : undefined;
    });
  }
}
