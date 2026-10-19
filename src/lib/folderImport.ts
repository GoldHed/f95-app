import * as installVersions from './installVersions';
import * as ipc from './ipc';
import * as libraries from './libraries';
import * as library from './library';
import { joinPath } from './organizedLayout';
import { isPathInside } from './paths';
import { applyLatestVersion } from './updates';
import type { GameFolderEntry } from './ipc';
import type { SamGameCard } from '../types/sam';

/**
 * Bring a folder of games that already sit on disk (one sub-folder per
 * game, named after it) into the library: each folder is matched to its
 * F95 thread so updates can be checked, and optionally reorganized into
 * `<Game>\Current`.
 */

export interface ImportCandidate {
  folder: GameFolderEntry;
  /** What was searched on F95 (folder name without a version suffix). */
  query: string;
  /** Version read from the folder name ("Game v0.5" → "v0.5"), if any. */
  folderVersion: string | null;
  /** SAM results for `query`, best first. */
  matches: SamGameCard[];
  /** Already in the library (some install points inside this folder). */
  alreadyImported: boolean;
}

export interface ImportChoice {
  candidate: ImportCandidate;
  match: SamGameCard;
  /** Installed version; null when unknown (the game then shows an update). */
  version: string | null;
  reorganize: boolean;
}

const SEARCH_DELAY_MS = 500;

/** "My Game v0.5.1" → { name: "My Game", version: "v0.5.1" }. */
export function splitFolderName(name: string): { name: string; version: string | null } {
  const bracket = name.match(/^(.*?)\s*[[(]\s*(v?\d[\w.\- ]*)\s*[\])]\s*$/i);
  if (bracket && bracket[1].trim()) return { name: bracket[1].trim(), version: bracket[2].trim() };
  const tail = name.match(/^(.*?)[\s_\-]+(v\d[\w.\-]*|\d+(?:\.\d+)+[a-z]?)\s*$/i);
  if (tail && tail[1].trim()) return { name: tail[1].trim(), version: tail[2] };
  return { name: name.trim(), version: null };
}

/** Search text for F95: separators to spaces, no repeated spaces. */
function searchText(name: string): string {
  return name.replace(/[_.]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Install folders the library already knows. */
async function knownInstallPaths(): Promise<string[]> {
  const games = await library.list({});
  return games.map((g) => g.installPath).filter((p): p is string => !!p);
}

/** List `root`'s game folders and look each one up on F95. */
export async function scan(
  root: string,
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<ImportCandidate[]> {
  const folders = await ipc.listGameFolders(root);
  const installed = await knownInstallPaths();
  const out: ImportCandidate[] = [];
  for (let i = 0; i < folders.length; i++) {
    if (signal?.aborted) break;
    const folder = folders[i];
    const { name, version } = splitFolderName(folder.name);
    const alreadyImported = installed.some((p) => isPathInside(p, folder.path));
    let matches: SamGameCard[] = [];
    if (!alreadyImported) {
      try {
        const page = await ipc.samList({ category: 'games', search: searchText(name), rows: 8 });
        matches = page.items;
      } catch (err) {
        console.warn('[import] F95 search failed for', folder.name, err);
      }
      if (i < folders.length - 1) await sleep(SEARCH_DELAY_MS);
    }
    out.push({ folder, query: searchText(name), folderVersion: version, matches, alreadyImported });
    onProgress?.(i + 1, folders.length);
  }
  return out;
}

/** Search F95 again with the user's own text (when the guess was wrong). */
export async function search(text: string): Promise<SamGameCard[]> {
  const page = await ipc.samList({ category: 'games', search: searchText(text), rows: 8 });
  return page.items;
}

/** Make sure `root` is an install library, so updates download there. */
export async function ensureLibrary(root: string): Promise<void> {
  if (await libraries.findContaining(joinPath(root, 'x'))) return;
  await libraries.add({ label: '', path: root });
}

/** Add one folder to the library. */
export async function importOne(choice: ImportChoice): Promise<void> {
  const { candidate, match, version, reorganize } = choice;
  const adopted = await ipc.adoptGameFolder({
    gameDir: candidate.folder.path,
    gameTitle: match.title,
    reorganize,
  });

  await library.add({
    threadId: match.threadId,
    category: 'games',
    title: match.title,
    threadUrl: match.threadUrl,
    thumbnailUrl: match.thumbnailUrl,
    currentVersion: version,
  });
  // add() keeps an existing row's version; an import states it explicitly.
  if (version) await library.applyVersion(match.threadId, version);

  if (adopted.exePath) {
    await library.setExe(match.threadId, adopted.exePath, adopted.currentDir);
  } else {
    await library.markInstalled(match.threadId, adopted.currentDir);
  }
  await installVersions.register({
    threadId: match.threadId,
    version,
    installPath: adopted.currentDir,
    exePath: adopted.exePath,
    engine: adopted.engine,
    sizeBytes: adopted.sizeBytes,
  });

  // An already-organized folder: its version folders become older versions.
  for (const name of candidate.folder.versionFolders) {
    await installVersions.register({
      threadId: match.threadId,
      version: name,
      installPath: joinPath(candidate.folder.path, name),
      exePath: null,
      engine: null,
      sizeBytes: null,
    });
  }
  // Compare with what F95 advertises now, so a game that is behind shows
  // its update straight away.
  const game = await library.get(match.threadId);
  if (game) await applyLatestVersion(game, match.version);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
