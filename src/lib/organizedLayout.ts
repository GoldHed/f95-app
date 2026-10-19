import * as installVersions from './installVersions';
import * as ipc from './ipc';
import { archiveParentDir } from './archives';
import { isPathInside, samePath } from './paths';
import type { LibraryGame } from '../types/library';

/**
 * The organized library layout:
 *
 *   <library>\<Game Name>\Current\   the version you play
 *   <library>\<Game Name>\v0.5.1\    older versions, one folder each
 *
 * Downloads still land in `<library>\<threadId>\` (the download manager's
 * staging folder); after extraction `placeExtraction` moves the files into
 * `Current`, renaming the previous `Current` to its version label first.
 */

export const CURRENT_DIR = 'Current';

export function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') || !dir.includes('/') ? '\\' : '/';
  return `${dir.replace(/[/\\]+$/, '')}${sep}${name}`;
}

/** Today as YYYY-MM-DD in local time (names "Previous (…)" folders). */
function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The game's folder: the one its current install already lives in when that
 * is organized (an imported folder keeps its own name), else a new folder
 * named after the title in `libraryRoot`.
 */
export async function gameDirFor(game: LibraryGame, libraryRoot: string): Promise<string> {
  const candidates = [game.installPath];
  for (const v of await installVersions.listRows(game.threadId)) candidates.push(v.installPath);
  for (const path of candidates) {
    if (!path) continue;
    const dir = await ipc.organizedGameDir(path).catch(() => null);
    if (dir) return dir;
  }
  return joinPath(libraryRoot, await ipc.gameFolderName(game.title));
}

export interface PlacedInstall {
  /** Where the new version now lives (`…\Current` when organized). */
  destDir: string;
  exePath: string | null;
  /** The previous active install, at its path after any move. */
  previousDir: string | null;
  previousExe: string | null;
  /** The previous `Current` was renamed to this version folder. */
  archivedDir: string | null;
  organized: boolean;
}

/**
 * Move a finished extraction into `<game>\Current`. The archive sits in
 * `<library>\<threadId>\`, so the library is two levels up from it. Paths
 * the database holds for the old `Current` are re-pointed at its version
 * folder.
 */
export async function placeExtraction(args: {
  game: LibraryGame;
  archivePath: string;
  extractedDir: string;
  exePath: string | null;
}): Promise<PlacedInstall> {
  const { game, archivePath, extractedDir, exePath } = args;
  const libraryRoot = archiveParentDir(archiveParentDir(archivePath));
  const gameDir = await gameDirFor(game, libraryRoot);
  const currentDir = joinPath(gameDir, CURRENT_DIR);

  // The label of what is in Current now: its registered version, else the
  // library row's version when the row points at Current.
  const rows = await installVersions.listRows(game.threadId);
  const currentRow = rows.find((r) => samePath(r.installPath, currentDir));
  // (The row's current_version only advances after this extraction.)
  const previousVersion = currentRow?.version ?? game.currentVersion;

  const out = await ipc.organizeInstall({
    gameDir,
    extractedDir,
    previousVersion,
    exePath,
    today: today(),
  });

  // By now the library row points at the download folder, so the old
  // Current (when there was one) is "the previous install" for the update
  // steps that follow: registering it as a version, copying saves, and
  // deleting it when old versions are not kept.
  let previousDir = game.installPath;
  let previousExe = game.exePath;
  if (out.archivedDir) {
    await installVersions.relocate(game.threadId, currentDir, out.archivedDir);
    previousDir = out.archivedDir;
    const oldExe = currentRow?.exePath ?? game.exePath;
    previousExe =
      oldExe && isPathInside(oldExe, currentDir)
        ? remapPath(oldExe, currentDir, out.archivedDir)
        : null;
  }
  return {
    destDir: out.currentDir,
    exePath: out.exePath,
    previousDir,
    previousExe,
    archivedDir: out.archivedDir,
    organized: true,
  };
}

function remapPath(path: string, oldRoot: string, newRoot: string): string {
  const base = oldRoot.replace(/[/\\]+$/, '');
  return newRoot + path.slice(base.length);
}
