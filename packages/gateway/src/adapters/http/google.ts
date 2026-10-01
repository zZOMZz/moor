import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { AppError, assert } from '@moor/protocol/protocol';
import { Accounts } from '../../features/accounts/service';
import {
  GoogleLogin,
  type GoogleOidcProvider,
  type GoogleClientProof,
  type GoogleCompletion,
} from '../../features/auth/google';
import { nodeCredentials } from '../crypto/credentials';
const CLIENT = 'moor_google_client',
  BROWSER = 'moor_google_browser',
  INVALID = 'Google 登录请求已失效，请重新开始';
export class GoogleHttpAuth {
  private readonly login: GoogleLogin;
  constructor(
    accounts: Accounts,
    private readonly options: { origin: string; setupToken: string; provider?: GoogleOidcProvider },
  ) {
    this.login = new GoogleLogin(
      accounts,
      {
        ...nodeCredentials,
        confirmationCode: () =>
          randomBytes(4)
            .toString('hex')
            .toUpperCase()
            .replace(/(.{4})(.{4})/, '$1-$2'),
        challenge: (verifier) => createHash('sha256').update(verifier).digest('base64url'),
      },
      options,
    );
  }
  get enabled() {
    return this.login.enabled;
  }
  close() {
    this.login.close();
  }
  setOrigin(origin: string) {
    this.options.origin = origin;
    this.login.invalidateOrigin();
  }
  private cookie(req: IncomingMessage, name: string) {
    const entries = (req.headers.cookie ?? '')
      .split(';')
      .map((v) => v.trim())
      .filter((v) => v.startsWith(name + '='));
    return entries.length === 1 ? entries[0]!.slice(name.length + 1) : '';
  }
  private proof(req: IncomingMessage): GoogleClientProof {
    return {
      personal: this.cookie(req, 'personal'),
      client: this.cookie(req, CLIENT),
      browser: this.cookie(req, BROWSER),
    };
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
  private complete(res: ServerResponse, result: GoogleCompletion) {
    if (result.loginSecret)
      res.setHeader('Set-Cookie', this.setCookie('personal', result.loginSecret, false, 2592000));
    this.json(res, { ok: true });
  }
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const limited =
      req.method === 'POST' &&
      ['/api/auth/google/start', '/api/auth/google/unlink'].includes(url.pathname);
    if (!limited) return this.handleRequest(req, res, url);
    assert(this.enabled, 404, 'Google 登录尚未配置');
    assert(req.headers.origin === this.options.origin, 403, '请求来源不匹配');
    return this.login.limited(req.socket.remoteAddress ?? 'unknown', () =>
      this.handleRequest(req, res, url),
    );
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
    if (req.method !== 'GET')
      assert(req.headers.origin === this.options.origin, 403, '请求来源不匹配');
    const proof = this.proof(req);
    if (path === '/api/auth/google/start' && req.method === 'POST') {
      const generation = this.login.originVersion;
      const result = await this.login.start(await this.body(req), proof, generation);
      if (!result.desktop) res.setHeader('Set-Cookie', this.setCookie(CLIENT, result.secret));
      this.json(res, {
        flowId: result.flowId,
        ...(result.desktop ? { secret: result.secret } : {}),
        code: result.code,
        expiresAt: result.expiresAt,
        launchPath: '/auth/google/start?flow=' + result.flowId,
      });
      return true;
    }
    if (path === '/auth/google/start' && req.method === 'GET') {
      assert([...url.searchParams].length === 1 && url.searchParams.has('flow'), 400, INVALID);
      const result = this.login.launch(url.searchParams.get('flow'), proof);
      res.setHeader('Set-Cookie', this.setCookie(BROWSER, result.browserSecret, true));
      this.redirect(res, result.destination);
      return true;
    }
    if (path === '/api/auth/google/callback' && req.method === 'GET') {
      let duplicate = false;
      for (const key of ['state', 'code', 'error', 'iss'])
        if (url.searchParams.getAll(key).length > 1) duplicate = true;
      await this.login.callback(
        {
          state: url.searchParams.get('state'),
          issuer: url.searchParams.get('iss'),
          code: url.searchParams.get('code'),
          error: duplicate || url.searchParams.has('error'),
        },
        proof,
      );
      this.redirect(res, '/auth/google/complete');
      return true;
    }
    if (path === '/api/auth/google/review' && req.method === 'GET') {
      this.json(res, this.login.review(proof));
      return true;
    }
    if (path === '/api/auth/google/confirm' && req.method === 'POST') {
      this.complete(res, this.login.confirm(await this.body(req), proof));
      return true;
    }
    if (path === '/api/auth/google/desktop/review' && req.method === 'POST') {
      this.json(res, this.login.desktopReview(await this.body(req), proof));
      return true;
    }
    if (path === '/api/auth/google/desktop/finish' && req.method === 'POST') {
      this.complete(res, this.login.desktopFinish(await this.body(req), proof));
      return true;
    }
    if (path === '/api/auth/google/cancel' && req.method === 'POST') {
      this.login.cancel(await this.body(req), proof);
      this.json(res, { ok: true });
      return true;
    }
    if (path === '/api/auth/google/unlink' && req.method === 'POST') {
      await this.login.unlink(await this.body(req), proof);
      this.json(res, { ok: true });
      return true;
    }
    throw new AppError(404, '未找到');
  }
}
