# Organized library, folder import and automatic updates

This fork adds three things on top of F95 App.

## 1. Organized install layout

Settings → Downloads → **Organize installs as "Game Name\Current"** (on by default).

```
E:\Games\                      ← an install library
├── Summertime Saga\
│   ├── Current\               ← the version you play
│   ├── v20.16\                ← older versions, one folder each
│   └── v20.11\
└── 12345\                     ← download staging folder (removed when empty)
```

How an install or update runs:

1. The download lands in `<library>\<threadId>\` as before and is extracted next to the archive.
2. `organize_install` (Rust, `src-tauri/src/organize.rs`):
   - renames an existing `Current` to the version it held (`v20.16`; `Previous (2026-10-19)` when unknown; ` (2)` added if that name is taken),
   - moves the extracted files into `Current`, unwrapping a single top-level folder (`Game-1.0-pc\…`) so `Current` holds the game files directly,
   - on failure, puts the old `Current` back. Moves are renames (instant) on the same drive, copy + delete across drives.
3. `src/lib/organizedLayout.ts` re-points the database at the new paths: the old version's row moves to its version folder, the library row points at `Current`.
4. The existing update steps then run as usual: saves are copied from the old version (when the engine matches), and the old version folder is deleted if "Keep the previous install" is off.

The game's folder is the one its current install already lives in (so an imported `Summertime Saga` folder keeps its name), else a new folder named after the F95 title. Updates download into the library the game is installed in, so the move is a same-drive rename.

## 2. Import existing game folders

Library → **Import folders**. Pick the folder holding one sub-folder per game.

- Each folder name is searched on F95 (SAM). A trailing version in the name (`Game v0.5`, `Game [0.5]`) is split off and pre-filled.
- Review: choose the right thread (or search again), and type the installed version. "I have vX" fills in F95's latest. An empty version means "unknown", and the game shows as having an update.
- With "Move each game's files into Current" checked, the folder's contents are moved into `Current` (renames only; folders that already have `Current` are left alone, and their other sub-folders are registered as older versions).
- The picked folder is added as an install library, so deletes are allowed there and updates download there.

Code: `src/lib/folderImport.ts`, `src/components/library/ImportFoldersModal.tsx`, Rust `adopt_game_folder` / `list_game_folders`.

## 3. Automatic update downloads

Settings → Downloads → **Download updates automatically after each update check** (off by default).

After every update check (manual or the background schedule), each installed game with a pending update gets its new version queued (`src/lib/autoUpdate.ts`):

- link: the first thread section meant for Windows (or the only, unlabeled one), best host first — Pixeldrain, GoFile, BuzzHeavier, Datanodes, Workupload, Mega, MediaFire, Google Drive, UploadHaven, … then the hosts that need a verification (VikingFile, AkiraBox, MixDrop). Browser-only hosts are never picked;
- a version is tried once: if any download of it exists (finished, failed, cancelled or waiting), nothing new is queued. Retry from the Downloads page;
- downloads that need a CAPTCHA wait in Downloads with the in-app verification button, as before.

## Planned: itch.io as a second update source

Not built yet. Notes for when it is:

- itch.io's documented server-side API (`https://itch.io/docs/api/serverside`) only covers games you develop plus your own download keys (`/profile/owned-keys`); it has no endpoint that lists a game's files or returns a download URL.
- Update detection that works for any public game: the game page's upload list (file names + dates) or its devlog RSS (`<game url>/devlog.rss`). For games published with butler, the API's `wharf/latest` endpoint returns a channel's latest version without authentication (see the server-side API docs for the exact parameters).
- Downloading: free games via the page's download flow; paid games need the user's download key from `/profile/owned-keys` (user API key from itch.io settings, stored like the other host credentials).
- Plumbing: a `source` column on `library_games` (`f95` | `itch`) and an `itch_url`, a check in `updateChecker.ts` for itch rows, and a resolver in `src-tauri/src/download/resolvers/` so the downloaded archive goes through the same extract → organize path.
