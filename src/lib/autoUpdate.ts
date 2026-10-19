import * as downloads from './downloads';
import { loadDownloadSettings } from './downloadSettings';
import { groupDownloads, hostDelivery } from './downloadHosts';
import { loadGameDetail } from './gameDetailCache';
import * as library from './library';
import { groupFitsOs } from './platformMatch';
import { startGameDownload } from './startGameDownload';
import { isInstalled, versionsEqual } from './updates';
import type { GameDownload } from '../types/game';
import type { LibraryGame } from '../types/library';

/**
 * Automatic updates: after an update check, every installed game F95 shows
 * a newer version for gets that version queued in the downloader, from the
 * best Windows link in its thread. Extraction (and, with the organized
 * layout, the move into `<Game>\Current`) then runs as for any download.
 *
 * A version is queued once: if any download of it exists (finished,
 * failed, cancelled or waiting for a verification), it is left to the
 * Downloads page rather than tried again on every check.
 */

/**
 * Hosts the app fetches with nobody at the keyboard, most reliable first.
 * Hosts needing a quick verification come after; browser-only hosts are
 * never picked.
 */
const HOST_PREFERENCE = [
  'pixeldrain',
  'gofile',
  'buzzheavier',
  'datanodes',
  'workupload',
  'mega',
  'mediafire',
  'gdrive',
  'uploadhaven',
  'bowfile',
  'uploadnow',
  'terminal',
  'vikingfile',
  'akirabox',
  'mixdrop',
];

const ACTIVE_STATES = new Set(['pending', 'resolving', 'awaiting_choice', 'downloading']);

function hostRank(host: string): number {
  const i = HOST_PREFERENCE.indexOf(host.trim().toLowerCase());
  return i === -1 ? HOST_PREFERENCE.length : i;
}

/**
 * The link to fetch: in the first thread section meant for Windows (or the
 * only, unlabeled one), the host the app handles best.
 */
export function pickAutoDownload(items: GameDownload[]): GameDownload | null {
  const groups = groupDownloads(items);
  const forWindows = groups.filter(([label]) => !label || groupFitsOs(label, 'windows'));
  // A thread with no Windows section at all is skipped rather than guessed.
  for (const [, links] of forWindows) {
    const usable = links
      .filter((l) => hostDelivery(l.host) !== 'browser')
      .sort((a, b) => hostRank(a.host) - hostRank(b.host));
    if (usable.length > 0) return usable[0];
  }
  return null;
}

async function alreadyQueued(threadId: string, version: string): Promise<boolean> {
  const rows = await downloads.listByThread(threadId);
  return rows.some(
    (r) =>
      ACTIVE_STATES.has(r.state) || (!!r.gameVersion && versionsEqual(r.gameVersion, version)),
  );
}

export interface AutoUpdateResult {
  queued: LibraryGame[];
  /** Games with an update whose thread had no link the app can fetch. */
  noLink: LibraryGame[];
}

/** Queue every pending update not tried yet (no-op when the setting is off). */
export async function queueAutoUpdates(): Promise<AutoUpdateResult> {
  const result: AutoUpdateResult = { queued: [], noLink: [] };
  const settings = await loadDownloadSettings();
  if (!settings.autoDownloadUpdates) return result;

  const pending = await library.listPendingUpdates({});
  for (const game of pending) {
    const version = game.availableVersion?.trim();
    if (!version || !isInstalled(game)) continue;
    if (game.category && game.category !== 'games') continue;
    try {
      if (await alreadyQueued(game.threadId, version)) continue;
      const detail = await loadGameDetail(game.threadId);
      // The thread moved on again since the check: fetch what it has now.
      const latest = detail.version?.trim() || version;
      const link = pickAutoDownload(detail.downloads);
      if (!link) {
        result.noLink.push(game);
        continue;
      }
      await startGameDownload(
        {
          threadId: game.threadId,
          category: game.category,
          title: game.title,
          threadUrl: game.threadUrl,
          thumbnailUrl: game.thumbnailUrl,
          version: latest,
        },
        link,
      );
      result.queued.push(game);
    } catch (err) {
      console.warn('[auto-update] could not queue', game.title, err);
    }
  }
  if (result.queued.length > 0 || result.noLink.length > 0) {
    console.info(
      `[auto-update] queued ${result.queued.length}, no usable link for ${result.noLink.length}`,
    );
  }
  return result;
}
