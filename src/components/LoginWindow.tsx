import { useEffect, useState, type FormEvent } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import * as ipc from '../lib/ipc';
import { probeOfflineQuick } from '../contexts/Offline';
import { saveCredentials, clearCredentials, loadCredentials } from '../lib/stronghold';
import { useT } from '../lib/i18n';
import { isBackendError, type BackendError } from '../types';
import { ErrorBanner } from './ErrorBanner';
import { Spinner } from './ui/Spinner';

type Phase =
  | { kind: 'checking' }       // bootstrap — checking session / stored creds
  | { kind: 'auto-login' }     // trying stored creds
  | { kind: 'form'; prefill?: { username: string; password: string } }
  | { kind: 'submitting' }     // user clicked Sign in
  | { kind: 'completing' };    // success — spawning main window

/**
 * Standalone login window. Renders the Steam-style sign-in flow:
 * a small fixed-size window with a compact title bar (drag + close only),
 * centered branding, and a single-purpose form.
 *
 * Boot sequence:
 *  1. `isLoggedIn()` — already authenticated? jump straight to main.
 *  2. Cached creds? try auto-login silently. Success → main.
 *  3. Show the form (prefilled if creds exist but were rejected).
 *  4. On submit: login → save creds (if "Remember me") → main.
 */
export function LoginWindow() {
  const { t } = useT();
  const [phase, setPhase] = useState<Phase>({ kind: 'checking' });
  const [error, setError] = useState<BackendError | string | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);

  // Bootstrap: try existing session, then stored creds, then show form.
  // EXCEPT when we arrived via `restart_to_login` — that path appends
  // `?logout=1` to our URL precisely to disable the auto-login fast-path.
  // Without this, a stale session cookie on disk could revive the session
  // immediately after the user clicked "Sign out".
  useEffect(() => {
    let cancelled = false;
    const cameFromLogout =
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).get('logout') === '1';

    (async () => {
      if (cameFromLogout) {
        // Defensive: wipe any creds that survived the main-window logout
        // (e.g. if `stronghold.save()` was slow to flush).
        await clearCredentials().catch(() => {});
        if (!cancelled) setPhase({ kind: 'form' });

        // Pre-warm the sidecar so the user's upcoming Sign in click
        // doesn't pay the ~1-2s Node spawn + init cost.
        //
        // CRITICAL: use `pingSidecar`, NOT `isLoggedIn` — the sidecar
        // serializes RPCs in a strict queue. `isLoggedIn` fires a GET
        // to F95Zone which can take many seconds; if the user clicks
        // Sign in while that's still in flight, the login RPC waits
        // behind it. `ping` is a no-op that returns instantly, freeing
        // the queue immediately.
        ipc.pingSidecar().catch(() => {});
        return;
      }

      const offline = await probeOfflineQuick();
      if (offline) {
        const hasSession = await ipc.hasLocalSession();
        if (hasSession && !cancelled) {
          await completeLogin();
          return;
        }
        if (!cancelled) setPhase({ kind: 'form' });
        return;
      }

      try {
        if (await ipc.isLoggedIn()) {
          if (!cancelled) await completeLogin();
          return;
        }
      } catch {
        // ignore — fall through
      }

      const stored = await loadCredentials().catch(() => null);
      if (stored) {
        if (cancelled) return;
        setPhase({ kind: 'auto-login' });
        try {
          await ipc.login(stored.username, stored.password);
          if (!cancelled) await completeLogin();
          return;
        } catch {
          if (!cancelled) {
            setUsername(stored.username);
            setPassword(stored.password);
            setPhase({ kind: 'form', prefill: stored });
          }
          return;
        }
      }

      if (!cancelled) setPhase({ kind: 'form' });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // "Sign in on the F95Zone page": the browser window reports back here.
  useEffect(() => {
    const unlisteners = [
      listen('f95-login:done', () => {
        void completeLogin();
      }),
      listen<string>('f95-login:error', (e) => {
        setError(e.payload);
        setPhase({ kind: 'form' });
      }),
    ];
    return () => {
      for (const u of unlisteners) void u.then((fn) => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function openBrowserLogin() {
    setError(null);
    try {
      await ipc.openF95LoginWindow();
    } catch (err) {
      setError(isBackendError(err) ? err : String(err));
    }
  }

  const browserLoginButton = (
    <button type="button" onClick={() => void openBrowserLogin()} style={browserLoginBtn}>
      {t('login.browser')}
    </button>
  );

  async function completeLogin() {
    setPhase({ kind: 'completing' });
    try {
      await ipc.completeLogin();
    } catch (err) {
      setError(isBackendError(err) ? err : String(err));
      setPhase({ kind: 'form' });
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPhase({ kind: 'submitting' });
    try {
      await ipc.login(username, password);
      if (remember) {
        await saveCredentials({ username, password });
      } else {
        await clearCredentials();
      }
      await completeLogin();
    } catch (err) {
      setError(isBackendError(err) ? err : String(err));
      setPhase({ kind: 'form' });
    }
  }

  const submitting = phase.kind === 'submitting' || phase.kind === 'completing';
  const showForm = phase.kind === 'form' || submitting;

  return (
    <div style={rootStyle}>
      <MiniTitleBar />

      <div style={bodyStyle}>
        <div className="app-logo" style={logoStyle} role="img" aria-label="F95 app" />

        {phase.kind === 'checking' || phase.kind === 'auto-login' ? (
          <div style={loadingStyle}>
            <Spinner />
            <span>
              {phase.kind === 'auto-login'
                ? t('login.autoLogin')
                : t('auth.loading')}
            </span>
            {browserLoginButton}
          </div>
        ) : phase.kind === 'completing' ? (
          <div style={loadingStyle}>
            <Spinner />
            <span>{t('login.opening')}</span>
          </div>
        ) : (
          showForm && (
            <form onSubmit={onSubmit} style={formStyle}>
              <h1 style={titleStyle}>{t('login.title')}</h1>

              {error && (
                <div style={{ margin: '4px 0 8px' }}>
                  <ErrorBanner error={error} onDismiss={() => setError(null)} />
                </div>
              )}

              <label style={fieldLabelStyle}>
                {t('login.username')}
                <input
                  type="text"
                  autoComplete="username"
                  autoFocus
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                  disabled={submitting}
                  style={inputStyle}
                />
              </label>

              <label style={fieldLabelStyle}>
                {t('login.password')}
                <input
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  disabled={submitting}
                  style={inputStyle}
                />
              </label>

              <label style={rememberRowStyle}>
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                  disabled={submitting}
                  style={{ accentColor: 'var(--accent)' }}
                />
                <span>{t('login.remember')}</span>
              </label>

              <button
                type="submit"
                disabled={submitting || !username || !password}
                style={{
                  ...submitBtn,
                  ...((submitting || !username || !password) ? submitDisabled : {}),
                }}
              >
                {submitting ? t('login.submitting') : t('login.submit')}
              </button>

              {browserLoginButton}
              <div style={hintStyle}>{t('login.browser.hint')}</div>
              <div style={hintStyle}>{t('login.hint')}</div>
            </form>
          )
        )}
      </div>
    </div>
  );
}

function MiniTitleBar() {
  const { t } = useT();
  return (
    <div style={miniBarStyle}>
      <div data-tauri-drag-region style={miniDragStyle} />
      <button
        type="button"
        className="titlebar-btn titlebar-close"
        style={miniCloseBtn}
        onClick={() => void getCurrentWindow().close()}
        aria-label={t('titlebar.close')}
        title={t('titlebar.close')}
      >
        <svg width="12" height="12" viewBox="0 0 12 12">
          <line x1="2" y1="2" x2="10" y2="10" stroke="currentColor" strokeWidth="1" />
          <line x1="10" y1="2" x2="2" y2="10" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
    </div>
  );
}


// ── styles ──────────────────────────────────────────────────────────────

const browserLoginBtn: React.CSSProperties = {
  marginTop: 8,
  padding: '8px 12px',
  background: 'transparent',
  border: '1px solid var(--border)',
  borderRadius: 4,
  color: 'var(--text-secondary)',
  font: 'inherit',
  fontSize: 13,
  cursor: 'pointer',
};

const rootStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100vh',
  background: 'var(--bg-base)',
  color: 'var(--text-secondary)',
  overflow: 'hidden',
};

const miniBarStyle: React.CSSProperties = {
  height: 28,
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'stretch',
  flexShrink: 0,
  borderBottom: '1px solid var(--border-faint)',
};

const miniDragStyle: React.CSSProperties = {
  flex: 1,
  height: '100%',
};

const miniCloseBtn: React.CSSProperties = {
  width: 42,
  height: '100%',
  background: 'transparent',
  border: 'none',
  color: 'var(--text-tertiary)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
  padding: 0,
};

const bodyStyle: React.CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'flex-start',
  padding: '28px 40px 32px',
  gap: 20,
  minHeight: 0,
};

const logoStyle: React.CSSProperties = {
  width: 180,
  height: 90,
  flexShrink: 0,
};

const loadingStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 14,
  color: 'var(--text-muted)',
  fontSize: 13,
  marginTop: 30,
};

const formStyle: React.CSSProperties = {
  width: '100%',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
};

const titleStyle: React.CSSProperties = {
  margin: 0,
  textAlign: 'center',
  fontSize: 16,
  fontWeight: 700,
  color: 'var(--text-primary)',
  marginBottom: 2,
};

const fieldLabelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 5,
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 0.6,
  color: 'var(--text-muted)',
  textTransform: 'uppercase',
};

const inputStyle: React.CSSProperties = {
  background: 'var(--bg-sunken)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border)',
  borderRadius: 3,
  padding: '9px 12px',
  fontSize: 14,
  outline: 'none',
  fontWeight: 500,
  // Override the global input bg from App.css with the deeper sunken color.
};

const rememberRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 12,
  color: 'var(--text-tertiary)',
  cursor: 'pointer',
  userSelect: 'none',
  marginTop: 2,
};

const submitBtn: React.CSSProperties = {
  marginTop: 6,
  padding: '11px',
  background: 'var(--accent)',
  color: 'var(--accent-text)',
  border: 'none',
  borderRadius: 3,
  fontSize: 14,
  fontWeight: 700,
  letterSpacing: 0.4,
  cursor: 'pointer',
  textTransform: 'uppercase',
};

const submitDisabled: React.CSSProperties = {
  background: 'var(--border-strong)',
  color: 'var(--text-muted)',
  cursor: 'not-allowed',
};

const hintStyle: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--text-faint)',
  textAlign: 'center',
  marginTop: 4,
};
