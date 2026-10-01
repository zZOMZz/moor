import { Dialog } from '@base-ui/react/dialog';
import type {
  GoogleMode as Mode,
  GoogleReview as Review,
} from '@moor/client/features/auth/google-auth';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Identity } from '../../platform/api';
import { useGoogleAuth, useNavigation } from '../../platform/ui-ports';

const message = (e: unknown) => (e instanceof Error ? e.message : 'Google 登录暂时不可用，请重试');

export function GoogleStart({ mode, disabled = false }: { mode: Mode; disabled?: boolean }) {
  const google = useGoogleAuth();
  const navigation = useNavigation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<{ code: string }>();
  const active = useRef(true),
    locked = useRef(false),
    waiting = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      if (waiting.current) void google.cancel().catch(() => {});
    };
  }, []);
  async function run(action: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (e) {
      if (active.current) setError(message(e));
    } finally {
      locked.current = false;
      if (active.current) setBusy(false);
    }
  }
  function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void run(async () => {
      const input = {
        mode,
        ...(mode === 'setup' ? { setupToken: String(data.get('setupToken') ?? '') } : {}),
        ...(mode === 'link' ? { password: String(data.get('password') ?? '') } : {}),
      };
      waiting.current = true;
      const result = await google.begin(input, () => active.current);
      if (!active.current) return;
      if (result.kind === 'confirmation') {
        waiting.current = true;
        setPending({ code: result.code });
      } else waiting.current = false;
    });
  }
  return (
    <div className="google-login">
      {pending ? (
        <>
          <p>在系统浏览器选择 Google 账号，核对两边的确认码：</p>
          <p className="google-confirm-code">
            <strong>{pending.code}</strong>
          </p>
          <p>浏览器确认后，返回这里完成登录。</p>
          <div className="session-dialog-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const result = await google.complete(() => active.current);
                  if (!active.current) return;
                  if (result.completed) {
                    waiting.current = false;
                    navigation.reload();
                  } else setError('登录尚未完成。请核对系统浏览器，或取消后重新发起。');
                })
              }
            >
              完成 Google 登录
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await google.cancel();
                  waiting.current = false;
                  if (active.current) setPending(undefined);
                })
              }
            >
              取消 Google 登录
            </button>
          </div>
        </>
      ) : (
        <form onSubmit={start}>
          {mode === 'setup' && (
            <label>
              Google 建号初始化口令
              <input
                name="setupToken"
                type="password"
                autoComplete="off"
                required
                maxLength={1024}
                disabled={busy || disabled}
              />
            </label>
          )}
          {mode === 'link' && (
            <label>
              验证当前 Moor 密码
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                required
                maxLength={1024}
                disabled={busy || disabled}
              />
            </label>
          )}
          <button type="submit" disabled={busy || disabled}>
            {busy
              ? '正在打开 Google 登录…'
              : mode === 'link'
                ? '绑定 Google 账号'
                : mode === 'setup'
                  ? '使用 Google 创建账号'
                  : '使用 Google 登录'}
          </button>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

export function GoogleComplete() {
  const google = useGoogleAuth();
  const current = useRef(true);
  useEffect(() => {
    current.current = true;
    return () => {
      current.current = false;
    };
  }, []);
  const [review, setReview] = useState<Review>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [checked, setChecked] = useState(false);
  const locked = useRef(false);
  useEffect(() => {
    let active = true;
    void google
      .review()
      .then((value) => {
        if (active) setReview(value);
      })
      .catch((e) => {
        if (active) setError(message(e));
      });
    return () => {
      active = false;
    };
  }, []);
  async function confirm() {
    if (!review || locked.current || (review.desktop && !checked)) return;
    locked.current = true;
    setBusy(true);
    setError('');
    try {
      await google.confirm(review.flowId, review.desktop, () => current.current);
      if (current.current && review.desktop) setDone(true);
    } catch (e) {
      setError(message(e));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  return (
    <main className="google-complete">
      <section className="auth" aria-labelledby="google-title">
        <h1 id="google-title">{done ? '浏览器确认已完成' : '确认 Google 账号'}</h1>
        {done ? (
          <p>返回发起登录的 Moor 桌面窗口，手动完成登录。可以关闭此页面。</p>
        ) : review ? (
          <>
            <p>
              {review.mode === 'link'
                ? '将此 Google 账号绑定到已登录的 Moor 个人账号：'
                : '使用此 Google 账号继续：'}
            </p>
            <p>
              <strong>{review.email}</strong>
            </p>
            {review.desktop && (
              <>
                <p>仅当你刚刚在自己的 Moor 桌面窗口发起请求时继续。</p>
                <p className="google-confirm-code">
                  <strong>{review.code}</strong>
                </p>
                <label className="google-code-check">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(event) => setChecked(event.target.checked)}
                    disabled={busy}
                  />
                  此确认码与我的 Moor 桌面窗口一致
                </label>
              </>
            )}
            <button
              type="button"
              disabled={busy || (review.desktop && !checked)}
              onClick={() => void confirm()}
            >
              {busy
                ? '正在确认…'
                : review.desktop
                  ? '允许这次桌面登录'
                  : review.mode === 'link'
                    ? '确认绑定 Google 账号'
                    : '确认登录'}
            </button>
          </>
        ) : (
          !error && <p role="status">正在核对登录请求…</p>
        )}
        {error && <p role="alert">{error}</p>}
        {!done && (
          <p>
            <a href="/">返回 Moor</a>
          </p>
        )}
      </section>
    </main>
  );
}

export function GoogleAccount({
  identity,
  onRefresh,
  onClose,
}: {
  identity: Identity;
  onRefresh: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const auth = useGoogleAuth();
  const lock = useRef(false);
  const google = identity.google;
  return (
    <Dialog.Root open onOpenChange={(open) => !open && !busy && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="session-dialog-backdrop" />
        <Dialog.Popup className="session-dialog google-account">
          <Dialog.Title>Google 登录设置</Dialog.Title>
          <Dialog.Description>管理此 Moor 个人账号的 Google 登录方式。</Dialog.Description>
          {!google?.enabled ? (
            <p>此中转尚未配置 Google 登录。</p>
          ) : google.linked ? (
            <>
              <p>
                已绑定：<strong>{google.linked.email}</strong>
              </p>
              {google.hasPassword ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (lock.current) return;
                    const data = new FormData(event.currentTarget);
                    lock.current = true;
                    setBusy(true);
                    setError('');
                    void auth
                      .unlink(String(data.get('password') ?? ''))
                      .then(onRefresh)
                      .catch((e) => setError(message(e)))
                      .finally(() => {
                        lock.current = false;
                        setBusy(false);
                      });
                  }}
                >
                  <label>
                    验证 Moor 密码以解除绑定
                    <input
                      name="password"
                      type="password"
                      autoComplete="current-password"
                      required
                      maxLength={1024}
                      disabled={busy}
                    />
                  </label>
                  <button type="submit" disabled={busy}>
                    解除 Google 绑定
                  </button>
                </form>
              ) : (
                <p>
                  当前使用 Google
                  登录。需要更换登录方式时，可在中转服务器本机设置恢复密码，再回来解除绑定。
                </p>
              )}
            </>
          ) : (
            <>
              <p>绑定后可在你的其他设备上使用 Google 登录此账号。</p>
              <GoogleStart mode="link" />
            </>
          )}
          {error && <p role="alert">{error}</p>}
          <div className="session-dialog-actions">
            <button type="button" disabled={busy} onClick={onClose}>
              关闭 Google 登录设置
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
