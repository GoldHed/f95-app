//! "Organized" library layout:
//!
//! ```text
//! <library>\<Game Name>\Current\        ← the version you play
//! <library>\<Game Name>\v0.5.1\         ← an older version, kept as-is
//! <library>\<Game Name>\v0.4\
//! ```
//!
//! After an archive is extracted, [`organize`] moves whatever sits in
//! `Current` into a folder named after its version, then moves the freshly
//! extracted files into `Current`. [`adopt`] turns a folder that holds the
//! game files directly (how most people keep games by hand) into the same
//! layout by moving its contents into `Current`.
//!
//! Everything here is plain `std` so it can be unit-tested without Tauri.
//! Moves use `rename` (instant on the same drive) and fall back to copy +
//! delete across drives. A failed step undoes the steps before it, so the
//! game folder is never left half-moved.

use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// Name of the folder that always holds the version being played.
pub const CURRENT_DIR: &str = "Current";

/// Names Windows refuses as file or folder names, whatever the extension.
const RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// A string made safe as one Windows folder name: illegal characters become
/// `_`, trailing dots/spaces go (Windows drops them silently), reserved
/// device names get a `_` suffix. Empty input becomes `fallback`.
pub fn sanitize_folder_name(name: &str, fallback: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if (c as u32) < 0x20 => '_',
            c => c,
        })
        .collect();
    let trimmed = cleaned
        .trim_start()
        .trim_end_matches(|c: char| c == '.' || c.is_whitespace());
    if trimmed.is_empty() {
        return fallback.to_string();
    }
    let stem = trimmed.split('.').next().unwrap_or("").to_ascii_uppercase();
    if RESERVED.contains(&stem.as_str()) {
        return format!("{trimmed}_");
    }
    // Leave room for the rest of the path (MAX_PATH is still a thing for
    // many old game engines).
    trimmed.chars().take(120).collect()
}

/// Folder name for an archived version: the F95 label as written ("v0.5.1",
/// "Final", "Ep. 3"), or `Previous (<today>)` when the version is unknown.
/// Never "Current", which would collide with the live install.
pub fn version_folder_name(version: Option<&str>, today: &str) -> String {
    let fallback = format!("Previous ({today})");
    let name = match version.map(str::trim).filter(|v| !v.is_empty()) {
        Some(v) => sanitize_folder_name(v, &fallback),
        None => fallback,
    };
    if name.eq_ignore_ascii_case(CURRENT_DIR) {
        format!("{name} (old)")
    } else {
        name
    }
}

/// `parent\name` when free, else `parent\name (2)`, `(3)`… so an archived
/// version never overwrites another one with the same label.
pub fn unique_child(parent: &Path, name: &str) -> PathBuf {
    let first = parent.join(name);
    if !first.exists() {
        return first;
    }
    (2..)
        .map(|n| parent.join(format!("{name} ({n})")))
        .find(|p| !p.exists())
        .expect("unbounded range always yields a free name")
}

/// Most archives wrap the game in one folder (`MyGame-0.5-pc\…`). When the
/// extraction holds exactly one directory and nothing else, that directory
/// is the real game root, so `Current` holds the game files directly.
pub fn content_root(extracted: &Path) -> io::Result<PathBuf> {
    let mut entries = fs::read_dir(extracted)?
        .filter_map(Result::ok)
        .filter(|e| !is_junk(&e.file_name()));
    match (entries.next(), entries.next()) {
        (Some(only), None) if only.file_type()?.is_dir() => Ok(only.path()),
        _ => Ok(extracted.to_path_buf()),
    }
}

/// OS litter that should not stop a single wrapper folder being unwrapped.
fn is_junk(name: &OsString) -> bool {
    let n = name.to_string_lossy();
    n.eq_ignore_ascii_case("__MACOSX") || n.eq_ignore_ascii_case("Thumbs.db") || n == ".DS_Store"
}

/// Move a directory. `rename` when possible; across drives (or when rename
/// is refused) copy to `<dst>.partial`, rename that into place, then delete
/// the source — a half-finished copy never looks like a real install.
pub fn move_dir(src: &Path, dst: &Path) -> io::Result<()> {
    if dst.exists() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!("{} already exists", dst.display()),
        ));
    }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)?;
    }
    if fs::rename(src, dst).is_ok() {
        return Ok(());
    }
    let mut partial = dst.as_os_str().to_owned();
    partial.push(".partial");
    let partial = PathBuf::from(partial);
    if partial.exists() {
        fs::remove_dir_all(&partial)?;
    }
    if let Err(e) = copy_tree(src, &partial).and_then(|_| fs::rename(&partial, dst)) {
        let _ = fs::remove_dir_all(&partial);
        return Err(e);
    }
    fs::remove_dir_all(src)
}

fn copy_tree(src: &Path, dst: &Path) -> io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let target = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

/// `path` re-expressed under `new_root` when it sits inside `old_root`.
pub fn remap(path: &Path, old_root: &Path, new_root: &Path) -> Option<PathBuf> {
    path.strip_prefix(old_root).ok().map(|rel| new_root.join(rel))
}

#[derive(Debug, PartialEq, Eq)]
pub struct Organized {
    /// `<game>\Current`, now holding the new version.
    pub current_dir: PathBuf,
    /// Where the previous `Current` went, if there was one.
    pub archived_dir: Option<PathBuf>,
    /// The new version's exe, re-pointed into `Current`.
    pub exe_path: Option<PathBuf>,
}

/// Put a fresh extraction in place:
/// 1. an existing `<game>\Current` is renamed to its version's folder;
/// 2. the extracted files (unwrapped from a single top folder) become
///    `<game>\Current`;
/// 3. the now-empty extraction folder is removed.
///
/// If step 2 fails, step 1 is undone.
pub fn organize(
    game_dir: &Path,
    extracted_dir: &Path,
    previous_version: Option<&str>,
    exe_path: Option<&Path>,
    today: &str,
) -> io::Result<Organized> {
    fs::create_dir_all(game_dir)?;
    let current = game_dir.join(CURRENT_DIR);
    let source = content_root(extracted_dir)?;

    if crate_paths_overlap(&source, &current) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "the extracted files are already inside the game's Current folder",
        ));
    }

    let archived_dir = if current.exists() {
        let target = unique_child(game_dir, &version_folder_name(previous_version, today));
        fs::rename(&current, &target)?;
        Some(target)
    } else {
        None
    };

    if let Err(e) = move_dir(&source, &current) {
        if let Some(archived) = &archived_dir {
            // Put the old version back where the app expects it.
            let _ = fs::rename(archived, &current);
        }
        return Err(e);
    }

    if source != extracted_dir {
        // Only the empty wrapper (and maybe OS litter) is left.
        let _ = fs::remove_dir_all(extracted_dir);
    }

    let exe_path = exe_path.and_then(|exe| remap(exe, &source, &current));
    Ok(Organized {
        current_dir: current,
        archived_dir,
        exe_path,
    })
}

/// Turn a hand-made game folder (game files directly inside) into the
/// organized layout by moving everything into `<game>\Current`. Returns the
/// `Current` path. Already organized (a `Current` folder exists): nothing
/// moves. On a failed move, the items already moved are put back.
pub fn adopt(game_dir: &Path) -> io::Result<PathBuf> {
    let current = game_dir.join(CURRENT_DIR);
    if current.is_dir() {
        return Ok(current);
    }
    let staging = unique_child(game_dir, ".current-staging");
    fs::create_dir(&staging)?;

    let children: Vec<PathBuf> = fs::read_dir(game_dir)?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p != &staging)
        .collect();

    let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();
    for child in children {
        let name = child.file_name().expect("read_dir entries have names");
        let target = staging.join(name);
        match fs::rename(&child, &target) {
            Ok(()) => moved.push((child, target)),
            Err(e) => {
                for (orig, now) in moved.iter().rev() {
                    let _ = fs::rename(now, orig);
                }
                let _ = fs::remove_dir(&staging);
                return Err(e);
            }
        }
    }
    if let Err(e) = fs::rename(&staging, &current) {
        for (orig, now) in moved.iter().rev() {
            let _ = fs::rename(now, orig);
        }
        let _ = fs::remove_dir(&staging);
        return Err(e);
    }
    Ok(current)
}

/// Delete `dir` only when it is empty (e.g. the per-download folder after
/// its archive was removed). Returns whether it was removed.
pub fn remove_if_empty(dir: &Path) -> io::Result<bool> {
    if !dir.is_dir() || fs::read_dir(dir)?.next().is_some() {
        return Ok(false);
    }
    fs::remove_dir(dir)?;
    Ok(true)
}

/// The organized game folder an install path belongs to: the parent of a
/// `Current` folder, or of a version folder next to one. `None` when the
/// path is not in the organized layout.
pub fn game_dir_of(install_path: &Path) -> Option<PathBuf> {
    let parent = install_path.parent()?;
    let is_current = install_path
        .file_name()
        .map(|n| n.to_string_lossy().eq_ignore_ascii_case(CURRENT_DIR))
        .unwrap_or(false);
    if is_current || parent.join(CURRENT_DIR).is_dir() {
        Some(parent.to_path_buf())
    } else {
        None
    }
}

fn crate_paths_overlap(a: &Path, b: &Path) -> bool {
    a.starts_with(b) || b.starts_with(a)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static N: AtomicU32 = AtomicU32::new(0);

    fn tmp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "organize-test-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn touch(p: &Path, body: &str) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, body).unwrap();
    }

    fn read(p: &Path) -> String {
        fs::read_to_string(p).unwrap()
    }

    #[test]
    fn sanitizes_names() {
        assert_eq!(sanitize_folder_name("Ep. 3: The End?", "x"), "Ep. 3_ The End_");
        assert_eq!(sanitize_folder_name("v1.0.", "x"), "v1.0");
        assert_eq!(sanitize_folder_name("   ", "x"), "x");
        assert_eq!(sanitize_folder_name("con", "x"), "con_");
        assert_eq!(sanitize_folder_name("Con.txt", "x"), "Con.txt_");
    }

    #[test]
    fn version_names() {
        assert_eq!(version_folder_name(Some("v0.5.1"), "2026-10-19"), "v0.5.1");
        assert_eq!(version_folder_name(None, "2026-10-19"), "Previous (2026-10-19)");
        assert_eq!(version_folder_name(Some("  "), "d"), "Previous (d)");
        assert_eq!(version_folder_name(Some("current"), "d"), "current (old)");
    }

    #[test]
    fn first_install_unwraps_single_folder() {
        let root = tmp();
        let game = root.join("My Game");
        let extracted = root.join("12345").join("MyGame-0.5-pc");
        touch(&extracted.join("MyGame-0.5-pc").join("Game.exe"), "new");
        let exe = extracted.join("MyGame-0.5-pc").join("Game.exe");

        let out = organize(&game, &extracted, None, Some(&exe), "d").unwrap();
        assert_eq!(out.current_dir, game.join("Current"));
        assert_eq!(out.archived_dir, None);
        assert_eq!(out.exe_path, Some(game.join("Current").join("Game.exe")));
        assert_eq!(read(&game.join("Current").join("Game.exe")), "new");
        assert!(!extracted.exists());
    }

    #[test]
    fn update_archives_previous_version() {
        let root = tmp();
        let game = root.join("My Game");
        touch(&game.join("Current").join("Game.exe"), "old");
        let extracted = root.join("12345").join("MyGame-0.6");
        touch(&extracted.join("Game.exe"), "new");
        touch(&extracted.join("data").join("a.rpa"), "x");

        let out = organize(&game, &extracted, Some("v0.5"), None, "d").unwrap();
        assert_eq!(out.archived_dir, Some(game.join("v0.5")));
        assert_eq!(read(&game.join("v0.5").join("Game.exe")), "old");
        assert_eq!(read(&game.join("Current").join("Game.exe")), "new");
        assert!(game.join("Current").join("data").join("a.rpa").exists());
        assert!(!extracted.exists());
    }

    #[test]
    fn same_version_label_twice_gets_suffix() {
        let root = tmp();
        let game = root.join("G");
        fs::create_dir_all(game.join("v1")).unwrap();
        touch(&game.join("Current").join("f"), "old");
        let extracted = root.join("dl").join("x");
        touch(&extracted.join("f"), "new");
        let out = organize(&game, &extracted, Some("v1"), None, "d").unwrap();
        assert_eq!(out.archived_dir, Some(game.join("v1 (2)")));
    }

    #[test]
    fn failed_move_restores_current() {
        let root = tmp();
        let game = root.join("G");
        touch(&game.join("Current").join("f"), "old");
        // Source does not exist: the move into Current fails.
        let missing = root.join("nope");
        assert!(organize(&game, &missing, Some("v1"), None, "d").is_err());
        assert_eq!(read(&game.join("Current").join("f")), "old");
        assert!(!game.join("v1").exists());
    }

    #[test]
    fn adopt_moves_loose_files_into_current() {
        let root = tmp();
        let game = root.join("Hand Made");
        touch(&game.join("Game.exe"), "exe");
        touch(&game.join("game").join("saves").join("1.save"), "s");

        let current = adopt(&game).unwrap();
        assert_eq!(current, game.join("Current"));
        assert_eq!(read(&current.join("Game.exe")), "exe");
        assert!(current.join("game").join("saves").join("1.save").exists());
        let left: Vec<_> = fs::read_dir(&game).unwrap().collect();
        assert_eq!(left.len(), 1);
        // Running it again changes nothing.
        assert_eq!(adopt(&game).unwrap(), current);
    }

    #[test]
    fn game_dir_detection() {
        let root = tmp();
        let game = root.join("G");
        fs::create_dir_all(game.join("Current")).unwrap();
        fs::create_dir_all(game.join("v1")).unwrap();
        assert_eq!(game_dir_of(&game.join("Current")), Some(game.clone()));
        assert_eq!(game_dir_of(&game.join("v1")), Some(game.clone()));
        assert_eq!(game_dir_of(&root.join("12345").join("x")), None);
    }

    #[test]
    fn remove_if_empty_only_removes_empty() {
        let root = tmp();
        let full = root.join("full");
        touch(&full.join("f"), "x");
        assert!(!remove_if_empty(&full).unwrap());
        let empty = root.join("empty");
        fs::create_dir_all(&empty).unwrap();
        assert!(remove_if_empty(&empty).unwrap());
        assert!(!empty.exists());
    }

    #[test]
    fn copy_fallback_works() {
        let root = tmp();
        let src = root.join("src");
        touch(&src.join("a").join("b.txt"), "hi");
        let dst = root.join("dst");
        copy_tree(&src, &dst).unwrap();
        assert_eq!(read(&dst.join("a").join("b.txt")), "hi");
    }
}
