//! Thin IPC adapters over the project domain. Payload field names arrive in
//! camelCase from TS (`#[tauri::command]` maps to the snake_case params here);
//! errors are the structured `{code, message, detail?}` from `project::error`.
//! TS contracts live in `src/bridge/project.ts`. Blocking file work runs on
//! the blocking pool; the mutex is only held for brief state updates.

use crate::project::assets::{
    clear_staging, export_blob, read_from_container, read_staged, stage_asset,
};
use crate::project::container::copy_container;
use crate::project::error::{ProjectError, ProjectResult};
use crate::project::html_export;
use crate::project::schema::{new_doc, AssetInfo, ProjectDoc};
use crate::project::{load_doc, now_rfc3339, save_doc, staging_for, SaveOutcome};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::ipc::Response;
use tauri::Manager;

/// One project open at a time; holds the active container path.
#[derive(Default)]
pub struct ProjectState {
    open: Mutex<Option<PathBuf>>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedProject {
    doc: ProjectDoc,
    assets: HashMap<String, AssetInfo>,
    path: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    path: String,
    bytes: u64,
    blob_count: usize,
    saved_at: String,
}

fn state_error() -> ProjectError {
    ProjectError::new("state_error", "Project state could not be accessed.")
}

fn open_path(state: &ProjectState) -> ProjectResult<PathBuf> {
    state
        .open
        .lock()
        .map_err(|_| state_error())?
        .clone()
        .ok_or_else(ProjectError::no_project_open)
}

fn set_open(state: &ProjectState, path: Option<PathBuf>) -> ProjectResult<()> {
    *state.open.lock().map_err(|_| state_error())? = path;
    Ok(())
}

fn absolute(path: &str) -> ProjectResult<PathBuf> {
    let parsed = PathBuf::from(path);
    if parsed.is_absolute() {
        Ok(parsed)
    } else {
        Err(ProjectError::invalid_path())
    }
}

/// Staging directory under the app cache dir. A missing cache dir is a typed
/// state error — never a silent `./pcb-re-studio/staging` in whatever happens
/// to be the current working directory.
fn staging_path(app: &tauri::AppHandle) -> ProjectResult<PathBuf> {
    let dir = app.path().app_cache_dir().map_err(|_| {
        ProjectError::with_detail(
            "state_error",
            "The asset staging directory could not be resolved.",
            "the app cache directory is unavailable",
        )
    })?;
    Ok(staging_for(&dir))
}

async fn blocking<T, F>(job: F) -> ProjectResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> ProjectResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|error| {
            ProjectError::with_detail(
                "task_failed",
                "The project operation could not be completed.",
                error.to_string(),
            )
        })?
}

fn loaded(doc: ProjectDoc, path: &Path) -> LoadedProject {
    let assets = doc.assets.clone();
    LoadedProject {
        doc,
        assets,
        path: path.to_string_lossy().into_owned(),
    }
}

fn save_result(outcome: SaveOutcome) -> SaveResult {
    SaveResult {
        path: outcome.path,
        bytes: outcome.bytes,
        blob_count: outcome.blob_count,
        saved_at: outcome.saved_at,
    }
}

/// Creates a fresh project at `path` and makes it active. The file is written
/// immediately, so there is never an unsaved-path state.
#[tauri::command]
pub async fn project_new(
    app: tauri::AppHandle,
    state: tauri::State<'_, ProjectState>,
    path: String,
    name: String,
) -> ProjectResult<LoadedProject> {
    let target = absolute(&path)?;
    let trimmed = name.trim().to_string();
    if trimmed.is_empty() {
        return Err(ProjectError::invalid_data(&[
            "project name must not be empty".to_string(),
        ]));
    }
    let staging = staging_path(&app)?;
    let now = now_rfc3339();
    let mut doc = new_doc(&trimmed, &now);
    let (outcome, saved) = blocking(move || {
        let outcome = save_doc(&mut doc, &target, None, &staging, &now)?;
        Ok((outcome, doc))
    })
    .await?;
    let active = PathBuf::from(&outcome.path);
    set_open(&state, Some(active.clone()))?;
    Ok(loaded(saved, &active))
}

/// Opens an existing `.pcbre` container and makes it active.
#[tauri::command]
pub async fn project_open(
    state: tauri::State<'_, ProjectState>,
    path: String,
) -> ProjectResult<LoadedProject> {
    let target = absolute(&path)?;
    let load_target = target.clone();
    let (doc, _) = blocking(move || load_doc(&load_target)).await?;
    set_open(&state, Some(target.clone()))?;
    Ok(loaded(doc, &target))
}

/// Copies an existing project to a new destination, validates the copied
/// container, then makes the copy active. The source is never modified.
#[tauri::command]
pub async fn project_import_copy(
    app: tauri::AppHandle,
    state: tauri::State<'_, ProjectState>,
    source_path: String,
    dest_path: String,
) -> ProjectResult<LoadedProject> {
    let source = absolute(&source_path)?;
    let target = absolute(&dest_path)?;
    let staging = staging_path(&app)?;
    let copy_source = source.clone();
    let copy_target = target.clone();
    blocking(move || copy_container(&copy_source, &copy_target)).await?;
    let load_target = target.clone();
    let (doc, _) = blocking(move || load_doc(&load_target)).await?;
    set_open(&state, Some(target.clone()))?;
    blocking(move || {
        clear_staging_best_effort(&staging);
        Ok(())
    })
    .await?;
    Ok(loaded(doc, &target))
}

/// Saves the active project in place. Blobs are sourced from staging first,
/// then stream-copied from the currently open container.
#[tauri::command]
pub async fn project_save(
    app: tauri::AppHandle,
    state: tauri::State<'_, ProjectState>,
    doc: ProjectDoc,
) -> ProjectResult<SaveResult> {
    let path = open_path(&state)?;
    let previous = path.clone();
    let staging = staging_path(&app)?;
    let now = now_rfc3339();
    let mut doc = doc;
    let outcome =
        blocking(move || save_doc(&mut doc, &path, Some(&previous), &staging, &now)).await?;
    set_open(&state, Some(PathBuf::from(&outcome.path)))?;
    Ok(save_result(outcome))
}

/// Saves the active project to a new path and switches the active target.
#[tauri::command]
pub async fn project_save_as(
    app: tauri::AppHandle,
    state: tauri::State<'_, ProjectState>,
    doc: ProjectDoc,
    path: String,
) -> ProjectResult<SaveResult> {
    let target = absolute(&path)?;
    let previous = open_path(&state)?;
    let staging = staging_path(&app)?;
    let now = now_rfc3339();
    let mut doc = doc;
    let outcome =
        blocking(move || save_doc(&mut doc, &target, Some(&previous), &staging, &now)).await?;
    set_open(&state, Some(PathBuf::from(&outcome.path)))?;
    Ok(save_result(outcome))
}

/// Closes the active project and clears staged assets.
#[tauri::command]
pub async fn project_close(
    app: tauri::AppHandle,
    state: tauri::State<'_, ProjectState>,
) -> ProjectResult<()> {
    set_open(&state, None)?;
    let staging = staging_path(&app)?;
    blocking(move || {
        clear_staging(&staging).map_err(|error| {
            ProjectError::with_detail("io_error", "A file operation failed.", error.to_string())
        })
    })
    .await?;
    Ok(())
}

/// Core of `project_export_copy`: saves a validated copy of `doc` to `target`,
/// sourcing blobs from the open container, WITHOUT switching the open target.
fn export_copy(
    doc: &mut ProjectDoc,
    target: &Path,
    previous_zip: &Path,
    asset_staging_root: &Path,
) -> ProjectResult<SaveOutcome> {
    let now = now_rfc3339();
    save_doc(doc, target, Some(previous_zip), asset_staging_root, &now)
}

/// Saves a standalone copy of the project to `path`. The currently open
/// project (and its path) stays exactly as it was.
#[tauri::command]
pub async fn project_export_copy(
    app: tauri::AppHandle,
    state: tauri::State<'_, ProjectState>,
    doc: ProjectDoc,
    path: String,
) -> ProjectResult<SaveResult> {
    let target = absolute(&path)?;
    let previous = open_path(&state)?;
    let staging = staging_path(&app)?;
    let mut doc = doc;
    let outcome = blocking(move || export_copy(&mut doc, &target, &previous, &staging)).await?;
    Ok(save_result(outcome))
}

/// Writes a standalone HTML document, inlining every referenced image blob
/// as a base64 data URI. Requires an open project for blob sourcing.
#[tauri::command]
pub async fn project_export_html(
    app: tauri::AppHandle,
    state: tauri::State<'_, ProjectState>,
    html: String,
    path: String,
) -> ProjectResult<u64> {
    let dest = absolute(&path)?;
    let open = open_path(&state)?;
    let staging = staging_path(&app)?;
    blocking(move || html_export::write_html(&html, &dest, &staging, Some(&open))).await
}

/// Core of `project_delete`: removes the container file; a missing file
/// already counts as deleted.
fn delete_container(path: &Path) -> ProjectResult<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(ProjectError::from(error)),
    }
}

/// Best-effort staging clear for after a project file is deleted: staged
/// files are cache-only, and the container is already gone, so a failure here
/// must not fail the command or leave the deleted project looking open
/// (mirrors the startup handling in `lib.rs`).
fn clear_staging_best_effort(staging: &Path) {
    if let Err(error) = clear_staging(staging) {
        eprintln!("failed to clear asset staging: {error}");
    }
}

/// Deletes the open container file, then closes the project and clears
/// staged assets. An IO failure keeps the project open (state is cleared
/// only after the file is gone); once it is gone, a staging-clear failure
/// is logged and ignored.
#[tauri::command]
pub async fn project_delete(
    app: tauri::AppHandle,
    state: tauri::State<'_, ProjectState>,
) -> ProjectResult<()> {
    let open = open_path(&state)?;
    let delete_path = open.clone();
    blocking(move || delete_container(&delete_path)).await?;
    set_open(&state, None)?;
    let staging = staging_path(&app)?;
    blocking(move || {
        clear_staging_best_effort(&staging);
        Ok(())
    })
    .await?;
    Ok(())
}

/// Stages an asset file (streams + SHA-256 in Rust; bytes never reach JS).
#[tauri::command]
pub async fn asset_import(
    app: tauri::AppHandle,
    state: tauri::State<'_, ProjectState>,
    path: String,
) -> ProjectResult<AssetInfo> {
    let source = absolute(&path)?;
    let open = open_path(&state)?;
    let staging = staging_path(&app)?;
    let known = blocking(move || {
        let (doc, blobs) = load_doc(&open)?;
        let mut known: HashSet<String> = blobs.into_iter().collect();
        known.extend(doc.assets.into_keys());
        Ok(known)
    })
    .await?;
    let info = blocking(move || stage_asset(&source, &staging, &known)).await?;
    Ok(info)
}

/// Reads a native clipboard image and stages it without sending pixels to JS.
#[tauri::command]
pub async fn asset_import_clipboard_image(
    app: tauri::AppHandle,
    state: tauri::State<'_, ProjectState>,
) -> ProjectResult<AssetInfo> {
    let open = open_path(&state)?;
    let staging = staging_path(&app)?;
    let png = blocking(crate::project::clipboard::read_png).await?;
    // Do not stage into a different project if a switch happened while reading.
    blocking(move || {
        let state = app.state::<ProjectState>();
        let guard = state.open.lock().map_err(|_| state_error())?;
        if guard.as_ref() != Some(&open) {
            return Err(ProjectError::new(
                "project_changed",
                "The open project changed. Paste the image again.",
            ));
        }
        crate::project::clipboard::stage_png(&png, &staging)
    })
    .await
}

/// Returns blob bytes as a binary IPC response (never base64/JSON).
#[tauri::command]
pub async fn asset_read(
    app: tauri::AppHandle,
    state: tauri::State<'_, ProjectState>,
    hash: String,
) -> ProjectResult<Response> {
    let open = open_path(&state)?;
    let staging = staging_path(&app)?;
    let bytes = blocking(move || {
        if let Some(bytes) = read_staged(&staging, &hash) {
            return Ok(bytes);
        }
        read_from_container(&open, &hash).ok_or_else(|| ProjectError::missing_blob(&hash))
    })
    .await?;
    Ok(Response::new(bytes))
}

/// Streams one blob out to a user-chosen file path.
#[tauri::command]
pub async fn asset_export(
    app: tauri::AppHandle,
    state: tauri::State<'_, ProjectState>,
    hash: String,
    dest_path: String,
) -> ProjectResult<()> {
    let dest = absolute(&dest_path)?;
    let open = open_path(&state)?;
    let staging = staging_path(&app)?;
    blocking(move || export_blob(&hash, &dest, &staging, Some(&open))).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::assets::{hash_file, stage_asset};
    use crate::project::schema::{AssetInfo, Board};
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn relative_paths_are_rejected() {
        assert_eq!(absolute("relative.pcbre").unwrap_err().code, "invalid_path");
        #[cfg(windows)]
        let absolute_path = r"C:\tmp\project.pcbre";
        #[cfg(not(windows))]
        let absolute_path = "/tmp/project.pcbre";
        assert!(absolute(absolute_path).is_ok());
    }

    #[test]
    fn missing_open_project_is_typed() {
        let state = ProjectState::default();
        assert_eq!(open_path(&state).unwrap_err().code, "no_project_open");
        set_open(&state, Some(PathBuf::from("x"))).unwrap();
        assert_eq!(open_path(&state).unwrap(), PathBuf::from("x"));
        set_open(&state, None).unwrap();
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "pcbre-commands-{tag}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn project_with_board(staging: &Path, payload: &[u8]) -> (ProjectDoc, String) {
        fs::write(staging.join("source.png"), payload).unwrap();
        let keep = HashSet::new();
        let info = stage_asset(&staging.join("source.png"), staging, &keep).unwrap();
        let (hash, size) = hash_file(&staging.join("source.png")).unwrap();
        assert_eq!(hash, info.hash);
        let mut doc = crate::project::schema::new_doc("Export", "2026-11-15T00:00:00Z");
        doc.assets.insert(
            hash.clone(),
            AssetInfo {
                hash: hash.clone(),
                size,
                name: "board.png".to_string(),
            },
        );
        doc.boards
            .push(Board::plain("b1", "Front", &hash, 640, 480));
        doc.active_board_id = Some("b1".to_string());
        (doc, hash)
    }

    #[test]
    fn export_copy_leaves_the_open_path_unchanged_and_loads_back() {
        let dir = temp_dir("export-copy");
        let staging = dir.join("staging");
        fs::create_dir_all(&staging).unwrap();
        let (mut doc, hash) = project_with_board(&staging, b"board-bytes");
        let open_target = dir.join("open.pcbre");
        let copy_target = dir.join("copy.pcbre");

        // The open project is saved in place first (what project_save does).
        save_doc(
            &mut doc,
            &open_target,
            None,
            &staging,
            "2026-11-15T00:00:00Z",
        )
        .unwrap();
        // The staging copy disappears (cleared on close / GC edge cases), so
        // the export must source the blob from the OPEN CONTAINER zip.
        fs::remove_file(staging.join(&hash)).unwrap();

        let state = ProjectState::default();
        set_open(&state, Some(open_target.clone())).unwrap();
        let mut copy = doc.clone();
        export_copy(&mut copy, &copy_target, &open_target, &staging).unwrap();

        // Open path unchanged: export_copy never touches the state.
        assert_eq!(open_path(&state).unwrap(), open_target);
        let (loaded, blobs) = load_doc(&copy_target).unwrap();
        assert_eq!(loaded.name, "Export");
        assert_eq!(blobs, vec![hash]);
        assert!(fs::metadata(&copy_target).unwrap().len() > 0);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn delete_container_is_idempotent_and_reports_io_errors() {
        let dir = temp_dir("delete");
        let target = dir.join("project.pcbre");
        // Missing file counts as deleted.
        delete_container(&target).unwrap();
        fs::write(&target, b"container").unwrap();
        delete_container(&target).unwrap();
        assert!(!target.exists());

        // A directory cannot be removed as a file → typed io_error, which
        // keeps the project open in the command wrapper (state is cleared
        // only after the file is gone).
        let blocked = dir.join("blocked.pcbre");
        fs::create_dir(&blocked).unwrap();
        let state = ProjectState::default();
        set_open(&state, Some(blocked.clone())).unwrap();
        let error = delete_container(&blocked).unwrap_err();
        assert_eq!(error.code, "io_error");
        assert_eq!(open_path(&state).unwrap(), blocked);
        assert!(blocked.is_dir());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn delete_clears_state_even_when_staging_cannot_be_cleared() {
        let dir = temp_dir("delete-staging");
        let target = dir.join("project.pcbre");
        fs::write(&target, b"container").unwrap();
        // Forcing `clear_staging` to fail is not portable: some Windows
        // hosts happily `remove_dir_all` a plain file. Drive the ordering
        // with a hostile staging root and assert the portable contract:
        // `clear_staging_best_effort` is total (never panics, never
        // propagates a failure), so the staging outcome never matters.
        let blockfile = dir.join("blockfile");
        fs::write(&blockfile, b"file").unwrap();
        let staging = blockfile;

        // project_delete's ordering: remove the file, clear the open state,
        // then clear staging best-effort — never the reverse, and a staging
        // failure never resurrects the deleted project as "open".
        let state = ProjectState::default();
        set_open(&state, Some(target.clone())).unwrap();
        delete_container(&target).unwrap();
        set_open(&state, None).unwrap();
        clear_staging_best_effort(&staging);

        assert!(!target.exists());
        assert_eq!(open_path(&state).unwrap_err().code, "no_project_open");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn best_effort_staging_clear_succeeds_when_staging_is_missing() {
        let dir = temp_dir("delete-staging-missing");
        let staging = dir.join("staging");
        clear_staging_best_effort(&staging);
        assert!(!staging.exists());
        fs::remove_dir_all(&dir).ok();
    }
}
