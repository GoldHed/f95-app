import { useEffect, useRef, useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import * as folderImport from '../../lib/folderImport';
import type { ImportCandidate } from '../../lib/folderImport';
import { useT } from '../../lib/i18n';
import type { SamGameCard } from '../../types/sam';

interface Props {
  open: boolean;
  onClose: () => void;
}

interface Row {
  candidate: ImportCandidate;
  include: boolean;
  matches: SamGameCard[];
  threadId: string | null;
  version: string;
  searchText: string;
  searching: boolean;
}

type Step =
  | { kind: 'pick' }
  | { kind: 'scanning'; done: number; total: number }
  | { kind: 'review'; root: string }
  | { kind: 'importing'; done: number; total: number }
  | { kind: 'done'; imported: number; failed: string[] };

/**
 * Import a folder of games already on disk (one sub-folder per game):
 * match each folder to its F95 thread, say which version is installed, and
 * optionally move each game's files into `<Game>\Current`.
 */
export function ImportFoldersModal({ open, onClose }: Props) {
  const { t } = useT();
  const [step, setStep] = useState<Step>({ kind: 'pick' });
  const [rows, setRows] = useState<Row[]>([]);
  const [reorganize, setReorganize] = useState(true);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (open) {
      setStep({ kind: 'pick' });
      setRows([]);
    }
    return () => abortRef.current?.abort();
  }, [open]);

  if (!open) return null;

  async function pickAndScan() {
    const picked = await openDialog({ directory: true, multiple: false, title: t('import.pick') });
    if (!picked || typeof picked !== 'string') return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setStep({ kind: 'scanning', done: 0, total: 0 });
    try {
      const found = await folderImport.scan(
        picked,
        (done, total) => setStep({ kind: 'scanning', done, total }),
        ctrl.signal,
      );
      if (ctrl.signal.aborted) return;
      setRows(
        found.map((c) => ({
          candidate: c,
          include: !c.alreadyImported && c.matches.length > 0,
          matches: c.matches,
          threadId: c.matches[0]?.threadId ?? null,
          version: c.folderVersion ?? '',
          searchText: c.query,
          searching: false,
        })),
      );
      setStep({ kind: 'review', root: picked });
    } catch (err) {
      setStep({ kind: 'pick' });
      console.error('[import] scan failed', err);
    }
  }

  function update(index: number, patch: Partial<Row>) {
    setRows((rs) => rs.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  async function searchAgain(index: number) {
    const row = rows[index];
    update(index, { searching: true });
    try {
      const matches = await folderImport.search(row.searchText);
      update(index, {
        matches,
        threadId: matches[0]?.threadId ?? null,
        include: matches.length > 0,
        searching: false,
      });
    } catch {
      update(index, { searching: false });
    }
  }

  async function runImport(root: string) {
    const chosen = rows.filter((r) => r.include && r.threadId);
    setStep({ kind: 'importing', done: 0, total: chosen.length });
    const failed: string[] = [];
    try {
      await folderImport.ensureLibrary(root);
    } catch (err) {
      console.warn('[import] could not register the folder as a library', err);
    }
    let done = 0;
    for (const r of chosen) {
      const match = r.matches.find((m) => m.threadId === r.threadId)!;
      try {
        await folderImport.importOne({
          candidate: r.candidate,
          match,
          version: r.version.trim() || null,
          reorganize,
        });
      } catch (err) {
        console.error('[import] failed', r.candidate.folder.name, err);
        failed.push(`${r.candidate.folder.name}: ${String((err as Error)?.message ?? err)}`);
      }
      done += 1;
      setStep({ kind: 'importing', done, total: chosen.length });
    }
    setStep({ kind: 'done', imported: chosen.length - failed.length, failed });
  }

  const selectedCount = rows.filter((r) => r.include && r.threadId).length;

  return (
    <div style={overlayStyle} onClick={step.kind === 'importing' ? undefined : onClose}>
      <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
        <h2 style={titleStyle}>{t('import.title')}</h2>

        {step.kind === 'pick' && (
          <>
            <p style={descStyle}>{t('import.intro')}</p>
            <div style={footerStyle}>
              <button type="button" className="ui-btn ui-btn--ghost" onClick={onClose}>
                {t('common.cancel')}
              </button>
              <button type="button" className="ui-btn ui-btn--primary" onClick={pickAndScan}>
                {t('import.pick')}
              </button>
            </div>
          </>
        )}

        {step.kind === 'scanning' && (
          <>
            <p style={descStyle} aria-live="polite">
              {t('import.scanning', { done: step.done, total: step.total || '…' })}
            </p>
            <div style={footerStyle}>
              <button
                type="button"
                className="ui-btn ui-btn--ghost"
                onClick={() => {
                  abortRef.current?.abort();
                  setStep({ kind: 'pick' });
                }}
              >
                {t('common.cancel')}
              </button>
            </div>
          </>
        )}

        {step.kind === 'review' && (
          <>
            <p style={descStyle}>{t('import.review')}</p>
            <div style={tableWrapStyle}>
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={thStyle} />
                    <th style={thStyle}>{t('import.col.folder')}</th>
                    <th style={thStyle}>{t('import.col.match')}</th>
                    <th style={thStyle}>{t('import.col.version')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => {
                    const match = r.matches.find((m) => m.threadId === r.threadId);
                    return (
                      <tr key={r.candidate.folder.path} style={r.include ? undefined : mutedRowStyle}>
                        <td style={tdStyle}>
                          <input
                            type="checkbox"
                            checked={r.include}
                            disabled={r.candidate.alreadyImported || !r.threadId}
                            onChange={(e) => update(i, { include: e.target.checked })}
                            aria-label={r.candidate.folder.name}
                          />
                        </td>
                        <td style={tdStyle} title={r.candidate.folder.path}>
                          <div style={folderNameStyle}>{r.candidate.folder.name}</div>
                          {r.candidate.alreadyImported && (
                            <div style={hintStyle}>{t('import.already')}</div>
                          )}
                          {r.candidate.folder.hasCurrent && !r.candidate.alreadyImported && (
                            <div style={hintStyle}>{t('import.hasCurrent')}</div>
                          )}
                        </td>
                        <td style={tdStyle}>
                          {!r.candidate.alreadyImported && (
                            <div style={matchCellStyle}>
                              {r.matches.length > 0 ? (
                                <select
                                  className="ui-select"
                                  style={{ width: '100%' }}
                                  value={r.threadId ?? ''}
                                  onChange={(e) => update(i, { threadId: e.target.value || null })}
                                >
                                  {r.matches.map((m) => (
                                    <option key={m.threadId} value={m.threadId}>
                                      {m.title}
                                      {m.version ? ` [${m.version}]` : ''}
                                      {m.creator ? ` — ${m.creator}` : ''}
                                    </option>
                                  ))}
                                </select>
                              ) : (
                                <span style={hintStyle}>{t('import.noMatch')}</span>
                              )}
                              <div style={searchRowStyle}>
                                <input
                                  style={inputStyle}
                                  value={r.searchText}
                                  onChange={(e) => update(i, { searchText: e.target.value })}
                                  onKeyDown={(e) => e.key === 'Enter' && searchAgain(i)}
                                  aria-label={t('import.searchAgain')}
                                />
                                <button
                                  type="button"
                                  className="ui-btn ui-btn--secondary ui-btn--sm"
                                  disabled={r.searching || !r.searchText.trim()}
                                  onClick={() => searchAgain(i)}
                                >
                                  {r.searching ? '…' : t('import.searchAgain')}
                                </button>
                              </div>
                            </div>
                          )}
                        </td>
                        <td style={tdStyle}>
                          {!r.candidate.alreadyImported && (
                            <div style={versionCellStyle}>
                              <input
                                style={inputStyle}
                                value={r.version}
                                placeholder={t('import.versionUnknown')}
                                onChange={(e) => update(i, { version: e.target.value })}
                                aria-label={t('import.col.version')}
                              />
                              {match?.version && (
                                <button
                                  type="button"
                                  className="ui-btn ui-btn--ghost ui-btn--sm"
                                  title={t('import.useLatest.hint')}
                                  onClick={() => update(i, { version: match.version ?? '' })}
                                >
                                  {t('import.useLatest', { version: match.version })}
                                </button>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <label style={checkRowStyle}>
              <input
                type="checkbox"
                checked={reorganize}
                onChange={(e) => setReorganize(e.target.checked)}
              />
              <span>{t('import.reorganize')}</span>
            </label>
            <div style={footerStyle}>
              <button type="button" className="ui-btn ui-btn--ghost" onClick={onClose}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="ui-btn ui-btn--primary"
                disabled={selectedCount === 0}
                onClick={() => runImport(step.root)}
              >
                {t('import.run', { count: selectedCount })}
              </button>
            </div>
          </>
        )}

        {step.kind === 'importing' && (
          <p style={descStyle} aria-live="polite">
            {t('import.importing', { done: step.done, total: step.total })}
          </p>
        )}

        {step.kind === 'done' && (
          <>
            <p style={descStyle}>{t('import.done', { count: step.imported })}</p>
            {step.failed.length > 0 && (
              <ul style={failListStyle}>
                {step.failed.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            )}
            <div style={footerStyle}>
              <button type="button" className="ui-btn ui-btn--primary" onClick={onClose}>
                {t('common.close')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.65)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
};
const modalStyle: React.CSSProperties = {
  background: 'var(--bg-base)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  padding: '20px 22px',
  width: 'min(960px, calc(100vw - 40px))',
  maxHeight: 'calc(100vh - 60px)',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
};
const titleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 17,
  fontWeight: 700,
  color: 'var(--text-primary)',
};
const descStyle: React.CSSProperties = { fontSize: 13, color: 'var(--text-tertiary)', margin: 0 };
const footerStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 8,
  marginTop: 4,
};
const tableWrapStyle: React.CSSProperties = {
  overflow: 'auto',
  border: '1px solid var(--border)',
  borderRadius: 4,
  minHeight: 120,
};
const tableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 13,
  color: 'var(--text-secondary)',
};
const thStyle: React.CSSProperties = {
  position: 'sticky',
  top: 0,
  background: 'var(--bg-elevated)',
  textAlign: 'left',
  padding: '8px 10px',
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--text-muted)',
  borderBottom: '1px solid var(--border)',
};
const tdStyle: React.CSSProperties = {
  padding: '8px 10px',
  borderBottom: '1px solid var(--border)',
  verticalAlign: 'top',
};
const mutedRowStyle: React.CSSProperties = { opacity: 0.55 };
const folderNameStyle: React.CSSProperties = {
  fontWeight: 600,
  color: 'var(--text-primary)',
  wordBreak: 'break-word',
};
const hintStyle: React.CSSProperties = { fontSize: 11, color: 'var(--text-muted)', marginTop: 2 };
const matchCellStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  minWidth: 280,
};
const searchRowStyle: React.CSSProperties = { display: 'flex', gap: 6 };
const versionCellStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  minWidth: 130,
};
const inputStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  height: 28,
  padding: '0 8px',
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border)',
  borderRadius: 4,
  color: 'var(--text-secondary)',
  font: 'inherit',
  fontSize: 12,
};
const checkRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 13,
  color: 'var(--text-secondary)',
};
const failListStyle: React.CSSProperties = {
  margin: 0,
  paddingLeft: 18,
  fontSize: 12,
  color: 'var(--text-muted)',
  maxHeight: 200,
  overflow: 'auto',
};
