//! Tauri commands for the organized library layout (`crate::organize`) and
//! for importing game folders that already sit on disk.

use super::fs::dir_size_of;
use crate::error::AppError;
use crate::organize;
use serde::Serialize;
use std::path::PathBuf;

#[derive(Debug, Serialize)]
pub struct OrganizeResult {
    #[serde(rename = "currentDir")]
    pub current_dir: String,
    #[serde(rename = "archivedDir")]
    pub archived_dir: Option<String>,
    #[serde(rename = "exePath")]
    pub exe_path: Option<String>,
}

fn s(p: PathBuf) -> String {
    p.to_string_lossy().into_owned()
}

async fn blocking<T: Send + 'static>(
    what: &'static str,
    f: impl FnOnce() -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| AppError::Other(format!("{what} join: {e}")))?
}

/// Move a fresh extraction into `<gameDir>\Current`, archiving the previous
/// `Current` under its version label. See `organize::organize`.
#[tauri::command]
pub async fn organize_install(
    game_dir: String,
    extracted_dir: String,
    previous_version: Option<String>,
    exe_path: Option<String>,
    today: String,
) -> Result<OrganizeResult, AppError> {
    blocking("organize_install", move || {
        let out = organize::organize(
            &PathBuf::from(&game_dir),
            &PathBuf::from(&extracted_dir),
            previous_version.as_deref(),
            exe_path.as_deref().map(std::path::Path::new),
            &today,
        )?;
        Ok(OrganizeResult {
            current_dir: s(out.current_dir),
            archived_dir: out.archived_dir.map(s),
            exe_path: out.exe_path.map(s),
        })
    })
    .await
}

#[derive(Debug, Serialize)]
pub struct AdoptResult {
    #[serde(rename = "currentDir")]
    pub current_dir: String,
    #[serde(rename = "exePath")]
    pub exe_path: Option<String>,
    pub engine: Option<String>,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
}

/// Bring an existing game folder into the library. With `reorganize`, its
/// contents move into `<gameDir>\Current` first; without, the folder is
/// used as it is. Either way the main exe and engine are detected.
#[tauri::command]
pub async fn adopt_game_folder(
    game_dir: String,
    game_title: String,
    reorganize: bool,
) -> Result<AdoptResult, AppError> {
    blocking("adopt_game_folder", move || {
        let dir = PathBuf::from(&game_dir);
        if !dir.is_dir() {
            return Err(AppError::Other(format!("folder not found: {}", dir.display())));
        }
        let current = dir.join(organize::CURRENT_DIR);
        let install = if reorganize {
            organize::adopt(&dir)?
        } else if current.is_dir() {
            current // already organized: play from Current
        } else {
            dir
        };
        let exe = crate::extraction::find_main_exe(&install, &game_title);
        Ok(AdoptResult {
            engine: crate::engine_detect::detect_engine(&install).map(str::to_string),
            size_bytes: dir_size_of(&install),
            exe_path: exe.map(s),
            current_dir: s(install),
        })
    })
    .await
}

#[derive(Debug, Serialize)]
pub struct GameFolderEntry {
    pub name: String,
    pub path: String,
    /// Already in the organized layout (has a `Current` folder).
    #[serde(rename = "hasCurrent")]
    pub has_current: bool,
    /// Version folders next to `Current` (organized layout only).
    #[serde(rename = "versionFolders")]
    pub version_folders: Vec<String>,
}

/// The immediate sub-folders of `root`: one per game when the user keeps
/// each game in a folder named after it.
#[tauri::command]
pub async fn list_game_folders(root: String) -> Result<Vec<GameFolderEntry>, AppError> {
    blocking("list_game_folders", move || {
        let mut out = Vec::new();
        for entry in std::fs::read_dir(&root)?.filter_map(Result::ok) {
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || name.starts_with('$') {
                continue; // .current-staging, $RECYCLE.BIN…
            }
            let path = entry.path();
            let has_current = path.join(organize::CURRENT_DIR).is_dir();
            let version_folders = if has_current {
                std::fs::read_dir(&path)?
                    .filter_map(Result::ok)
                    .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .filter(|n| !n.eq_ignore_ascii_case(organize::CURRENT_DIR))
                    .collect()
            } else {
                Vec::new()
            };
            out.push(GameFolderEntry {
                name,
                path: s(path),
                has_current,
                version_folders,
            });
        }
        out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        Ok(out)
    })
    .await
}

/// The organized game folder (`<library>\<Game>`) an install belongs to, or
/// null when the install is not in that layout.
#[tauri::command]
pub fn organized_game_dir(install_path: String) -> Option<String> {
    organize::game_dir_of(&PathBuf::from(install_path)).map(s)
}

/// Safe folder name for a game title (same rules the organizer uses).
#[tauri::command]
pub fn game_folder_name(title: String) -> String {
    organize::sanitize_folder_name(&title, "Game")
}

/// Remove `path` only if it is an empty directory.
#[tauri::command]
pub async fn remove_dir_if_empty(path: String) -> Result<bool, AppError> {
    blocking("remove_dir_if_empty", move || {
        Ok(organize::remove_if_empty(&PathBuf::from(path))?)
    })
    .await
}
