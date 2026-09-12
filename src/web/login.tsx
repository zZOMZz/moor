import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, LoaderCircle, Pause, Play } from 'lucide-react';
import { startWater, type WaterSurface } from './login-water';

export interface LoginProps {
  setup: boolean;
  onSubmit: (data: Record<string, FormDataEntryValue>) => Promise<void>;
}

export function Login({ setup, onSubmit }: LoginProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const water = useRef<WaterSurface | null>(null);
  const submitting = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    try {
      const appearance = localStorage.getItem('moor-appearance');
      if (appearance === 'light' || appearance === 'dark' || appearance === 'system') {
        document.documentElement.dataset.theme = appearance;
      }
    } catch {
      // Appearance remains system-controlled when storage is unavailable.
    }
    water.current = startWater(canvas.current!);
    return () => {
      water.current?.dispose();
      water.current = null;
    };
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    const data = Object.fromEntries(new FormData(event.currentTarget));
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      await onSubmit(data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '暂时无法登录，请重试。');
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return (
    <main className="login-scene">
      <div className="login-water" aria-hidden="true">
        <canvas ref={canvas} />
        <div className="login-water-haze" />
      </div>
      <div className="login-wordmark">
        <img className="moor-logo" src="/moor-logo.png" alt="Moor" width="132" height="44" />
      </div>
      <section className="auth" aria-labelledby="login-title">
        <div className="auth-heading">
          <span className="auth-eyebrow">A PLACE TO PICK UP</span>
          <h1 id="login-title">{setup ? '你的电脑，随处可达。' : '继续你的工作。'}</h1>
          <p>
            项目留在电脑上，
            <br />
            从任何一处，接着做下去。
          </p>
        </div>
        <form id="login" onSubmit={submit} aria-busy={busy}>
          <label htmlFor="login-email">邮箱</label>
          <input
            id="login-email"
            name="email"
            type="email"
            autoComplete="username"
            placeholder="you@example.com"
            required
            disabled={busy}
          />
          <label htmlFor="login-password">密码</label>
          <input
            id="login-password"
            name="password"
            type="password"
            autoComplete={setup ? 'new-password' : 'current-password'}
            minLength={setup ? 12 : 1}
            placeholder={setup ? '至少 12 位字符' : '输入你的密码'}
            required
            disabled={busy}
          />
          {setup && (
            <>
              <label htmlFor="login-token">初始化口令</label>
              <input
                id="login-token"
                name="setupToken"
                type="password"
                autoComplete="off"
                required
                disabled={busy}
                aria-describedby="setup-help"
              />
              <small id="setup-help">口令位于服务端首次启动时显示的文件中。</small>
            </>
          )}
          <p id="notice" className={error ? 'visible' : ''} role="alert">
            {error}
          </p>
          <button className="primary auth-submit" type="submit" disabled={busy}>
            <span>
              {busy ? (setup ? '正在创建账号' : '正在登录') : setup ? '创建个人账号' : '登录'}
            </span>
            {busy ? <LoaderCircle className="auth-spinner" /> : <ArrowRight />}
          </button>
        </form>
        <p className="auth-footnote">你的设备 · 你的项目 · 你的节奏</p>
      </section>
      <footer className="login-footer">
        <span>停泊于此，延续所想。</span>
        <button
          type="button"
          className="water-toggle"
          aria-label={paused ? '播放背景动效' : '暂停背景动效'}
          aria-pressed={paused}
          onClick={() => {
            water.current?.setPaused(!paused);
            setPaused(!paused);
          }}
        >
          {paused ? <Play /> : <Pause />}
          <span>水面光影</span>
        </button>
      </footer>
    </main>
  );
}
