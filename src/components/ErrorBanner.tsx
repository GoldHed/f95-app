import type { BackendError } from '../types';

interface Props {
  error: BackendError | string;
  onDismiss?: () => void;
}

const FRIENDLY: Record<string, string> = {
  invalid_credentials: 'Wrong username or password.',
  two_factor_required:
    'This account uses two-step verification. Use "Sign in on the F95Zone page" below.',
  cloudflare:
    'F95Zone asked for a browser check (Cloudflare). Use "Sign in on the F95Zone page" below.',
  sidecar_timeout: 'The background helper did not answer in time.',
  sidecar_crash: 'The background helper stopped unexpectedly.',
  not_initialized: 'The background helper has not started yet.',
  protocol: 'The app and its background helper could not understand each other.',
  io: 'Could not talk to the background helper.',
  other: 'Something went wrong.',
};

export function ErrorBanner({ error, onDismiss }: Props) {
  const isBackend = typeof error !== 'string';
  const title = isBackend ? FRIENDLY[error.code] ?? 'Error' : 'Error';
  const detail = isBackend ? error.message : error;

  return (
    <div
      style={{
        border: '1px solid #b00020',
        background: '#fde7ea',
        color: '#5a0010',
        padding: '0.75rem 1rem',
        borderRadius: 6,
        margin: '0.5rem 0',
        fontSize: 14,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
        <div>
          <strong>{title}</strong>
          {detail && detail !== title && (
            <div style={{ opacity: 0.85, marginTop: 4 }}>{detail}</div>
          )}
        </div>
        {onDismiss && (
          <button
            onClick={onDismiss}
            style={{
              background: 'transparent',
              border: 'none',
              color: '#5a0010',
              cursor: 'pointer',
              fontSize: 18,
              padding: 0,
              lineHeight: 1,
            }}
            aria-label="Close"
          >
            ×
          </button>
        )}
      </div>
    </div>
  );
}
