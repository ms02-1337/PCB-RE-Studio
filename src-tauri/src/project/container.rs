//! `.pcbre` container IO: a ZIP holding `project.json` (deflated) plus
//! `blobs/<sha256>` entries (stored), written atomically via a temp file.

use crate::project::error::{ProjectError, ProjectResult};
use crate::project::schema::{
    is_valid_hash, validate, ProjectDoc, PROJECT_JSON_CAP, SCHEMA_VERSION,
};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use zip::write::SimpleFileOptions;
use zip::CompressionMethod;

pub const PROJECT_JSON_ENTRY: &str = "project.json";
pub const BLOB_DIR: &str = "blobs";

/// Where the bytes for one hash come from when writing a container.
#[derive(Debug, Clone)]
pub enum BlobSource {
    /// A file already staged in the asset store.
    StagedFile(PathBuf),
    /// An entry inside the currently open project's container.
    ZipEntry(PathBuf),
}

/// Writes `project.json` plus every blob to `target` atomically: the archive is
/// built at `<target>.<8-hex>.tmp` in the same directory, flushed, then renamed
/// over the target. The temp file is removed on failure. Returns the final size.
pub fn write_container(
    target: &Path,
    project_json: &str,
    blobs: &BTreeMap<String, BlobSource>,
) -> ProjectResult<u64> {
    if project_json.len() > PROJECT_JSON_CAP {
        return Err(ProjectError::invalid_data(&[format!(
            "project.json exceeds the {PROJECT_JSON_CAP} byte limit"
        )]));
    }
    let directory = target.parent().unwrap_or_else(|| Path::new("."));
    let temp = unique_temp_path(target, directory);
    // Build, stat, and fsync the temp file, then rename it over the target —
    // all inside one Result chain. No early `?` sits between temp creation
    // and the cleanup below, so every failure path removes the temp file.
    let outcome = write_container_file(&temp, project_json, blobs)
        .and_then(|file| {
            let bytes = file
                .metadata()
                .map_err(|error| {
                    ProjectError::save_failed(format!("could not stat the temporary file: {error}"))
                })?
                .len();
            file.sync_all()
                .map_err(|error| ProjectError::save_failed(error.to_string()))?;
            Ok(bytes)
        })
        .and_then(|bytes| {
            // The handle is dropped before the rename (Windows rename of an
            // open file needs the share-delete flag, which we don't rely on).
            match fs::rename(&temp, target) {
                Ok(()) => Ok(bytes),
                Err(error) => Err(ProjectError::save_failed(format!(
                    "could not replace {}: {error}",
                    target.display()
                ))),
            }
        });
    if outcome.is_err() {
        let _ = fs::remove_file(&temp);
    }
    outcome
}

fn write_container_file(
    temp: &Path,
    project_json: &str,
    blobs: &BTreeMap<String, BlobSource>,
) -> ProjectResult<File> {
    let file = File::create(temp).map_err(|error| {
        ProjectError::save_failed(format!("could not create {}: {error}", temp.display()))
    })?;
    let mut writer = zip::ZipWriter::new(file);
    let json_options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    writer
        .start_file(PROJECT_JSON_ENTRY, json_options)
        .map_err(zip_write_error)?;
    writer.write_all(project_json.as_bytes()).map_err(|error| {
        ProjectError::save_failed(format!("could not write project.json: {error}"))
    })?;
    let blob_options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    for (hash, source) in blobs {
        let name = format!("{BLOB_DIR}/{hash}");
        match source {
            BlobSource::StagedFile(path) => {
                let mut file = File::open(path).map_err(|_| ProjectError::missing_blob(hash))?;
                writer
                    .start_file(name.as_str(), blob_options)
                    .map_err(zip_write_error)?;
                io::copy(&mut file, &mut writer).map_err(|error| {
                    ProjectError::save_failed(format!("could not write blob {hash}: {error}"))
                })?;
            }
            BlobSource::ZipEntry(zip_path) => {
                let zip_file =
                    File::open(zip_path).map_err(|_| ProjectError::missing_blob(hash))?;
                let mut archive = zip::ZipArchive::new(zip_file)
                    .map_err(|error| ProjectError::corrupt_container(error.to_string()))?;
                let entry = archive
                    .by_name(&name)
                    .map_err(|_| ProjectError::missing_blob(hash))?;
                writer.raw_copy_file(entry).map_err(zip_write_error)?;
            }
        }
    }
    let file = writer.finish().map_err(zip_write_error)?;
    Ok(file)
}

fn zip_write_error(error: zip::result::ZipError) -> ProjectError {
    ProjectError::save_failed(format!("could not write the project archive: {error}"))
}

/// Generates `<target name>.<8 lowercase hex>.tmp` next to the target,
/// avoiding collisions with existing files.
fn unique_temp_path(target: &Path, directory: &Path) -> PathBuf {
    for _ in 0..64 {
        let mut hasher = Sha256::new();
        hasher.update(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
                .to_le_bytes(),
        );
        hasher.update(std::process::id().to_le_bytes());
        hasher.update(target.to_string_lossy().as_bytes());
        let digest = hasher.finalize();
        let suffix: String = digest[..4]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        let name = format!(
            "{}.{suffix}.tmp",
            target
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default()
        );
        let candidate = directory.join(name);
        if !candidate.exists() {
            return candidate;
        }
    }
    directory.join(format!(
        "{}.{:016x}.tmp",
        target
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ))
}

/// Reads and validates a container. Returns the parsed document plus the set of
/// blob hashes actually present in the archive.
pub fn read_container(path: &Path) -> ProjectResult<(ProjectDoc, Vec<String>)> {
    let file = File::open(path).map_err(|error| {
        ProjectError::with_detail(
            "io_error",
            "The project file could not be opened.",
            error.to_string(),
        )
    })?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|error| ProjectError::corrupt_container(error.to_string()))?;
    let entry = archive
        .by_name(PROJECT_JSON_ENTRY)
        .map_err(|_| ProjectError::corrupt_container("missing project.json entry"))?;
    let mut json = Vec::new();
    entry
        .take(PROJECT_JSON_CAP as u64 + 1)
        .read_to_end(&mut json)
        .map_err(|error| ProjectError::corrupt_container(error.to_string()))?;
    if json.len() > PROJECT_JSON_CAP {
        return Err(ProjectError::corrupt_container(
            "project.json exceeds the 16 MiB limit",
        ));
    }
    let doc: ProjectDoc = serde_json::from_slice(&json).map_err(|error| {
        ProjectError::corrupt_container(format!("project.json is not valid JSON: {error}"))
    })?;
    if doc.schema_version != SCHEMA_VERSION {
        return Err(ProjectError::unsupported_schema_version(doc.schema_version));
    }
    validate(&doc)?;

    let mut blob_hashes = Vec::new();
    for name in archive.file_names() {
        let name = name
            .map_err(|error| ProjectError::corrupt_container(error.to_string()))?
            .into_owned();
        if let Some(hash) = name.strip_prefix(&format!("{BLOB_DIR}/")) {
            if is_valid_hash(hash) {
                blob_hashes.push(hash.to_string());
            }
        }
    }
    Ok((doc, blob_hashes))
}

/// Copies a valid project container to a new path without rewriting its
/// contents. The destination must not already exist, which keeps import from
/// replacing a user's unrelated project file. A sibling temporary file makes
/// the final rename atomic.
pub fn copy_container(source: &Path, target: &Path) -> ProjectResult<()> {
    let source = fs::canonicalize(source).map_err(ProjectError::from)?;
    let parent = target.parent().unwrap_or_else(|| Path::new("."));
    let parent = fs::canonicalize(parent).map_err(ProjectError::from)?;
    let file_name = target.file_name().ok_or_else(ProjectError::invalid_path)?;
    let target = parent.join(file_name);
    if target.exists() {
        let same = fs::canonicalize(&target)
            .map(|existing| existing == source)
            .unwrap_or(false);
        return Err(ProjectError::with_detail(
            if same { "same_path" } else { "already_exists" },
            if same {
                "Choose a different destination."
            } else {
                "The destination file already exists."
            },
            target.display().to_string(),
        ));
    }
    if target == source {
        return Err(ProjectError::with_detail(
            "same_path",
            "Choose a different destination.",
            target.display().to_string(),
        ));
    }

    // Validate before copying, then validate the copied bytes before making
    // them visible at the destination.
    read_container(&source)?;
    let temp = unique_temp_path(&target, &parent);
    let result = (|| {
        fs::copy(&source, &temp).map_err(ProjectError::from)?;
        fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&temp)
            .and_then(|file| file.sync_all())
            .map_err(ProjectError::from)?;
        read_container(&temp)?;
        // A hard link is an atomic no-clobber install on the same filesystem;
        // unlike rename it cannot replace a destination that appeared after
        // the initial existence check.
        match fs::hard_link(&temp, &target) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                return Err(ProjectError::with_detail(
                    "already_exists",
                    "The destination file already exists.",
                    target.display().to_string(),
                ));
            }
            #[cfg(windows)]
            Err(error) => {
                // Some Windows volumes disallow hard links. Rename within the
                // same directory still installs atomically and Windows refuses
                // to replace an existing target.
                if error.kind() != io::ErrorKind::PermissionDenied {
                    return Err(ProjectError::from(error));
                }
                fs::rename(&temp, &target).map_err(ProjectError::from)?;
                return Ok(());
            }
            #[cfg(not(windows))]
            Err(error) => return Err(ProjectError::from(error)),
        }
        let _ = fs::remove_file(&temp);
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::schema::{new_doc, AssetInfo, Board};
    use std::collections::HashMap;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "pcbre-container-{tag}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn doc_with_asset(hash: &str) -> ProjectDoc {
        let mut doc = new_doc("Container", "2026-11-15T00:00:00Z");
        doc.assets.insert(
            hash.to_string(),
            AssetInfo {
                hash: hash.to_string(),
                size: 11,
                name: "board.png".to_string(),
            },
        );
        doc.boards
            .push(Board::plain("board-1", "Front", hash, 10, 10));
        doc.active_board_id = Some("board-1".to_string());
        doc
    }

    fn staged(dir: &Path, hash: &str, bytes: &[u8]) -> PathBuf {
        let staging = dir.join("staging");
        fs::create_dir_all(&staging).unwrap();
        let path = staging.join(hash);
        fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = temp_dir("round-trip");
        let hash = "ab".repeat(32);
        let doc = doc_with_asset(&hash);
        let target = dir.join("project.pcbre");
        let mut blobs = BTreeMap::new();
        blobs.insert(
            hash.clone(),
            BlobSource::StagedFile(staged(&dir, &hash, b"board-bytes")),
        );
        let json = serde_json::to_string(&doc).unwrap();
        let bytes = write_container(&target, &json, &blobs).unwrap();
        assert!(bytes > 0);
        let (loaded, blob_hashes) = read_container(&target).unwrap();
        assert_eq!(loaded, doc);
        assert_eq!(blob_hashes, vec![hash]);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn copy_container_validates_and_copies_without_clobbering() {
        let dir = temp_dir("import-copy");
        let source = dir.join("source.pcbre");
        let destination = dir.join("destination.pcbre");
        let doc = new_doc("Imported", "2026-11-15T00:00:00Z");
        write_container(
            &source,
            &serde_json::to_string(&doc).unwrap(),
            &BTreeMap::new(),
        )
        .unwrap();

        copy_container(&source, &destination).unwrap();
        assert_eq!(fs::read(&source).unwrap(), fs::read(&destination).unwrap());
        assert_eq!(read_container(&destination).unwrap().0, doc);

        let error = copy_container(&source, &destination).unwrap_err();
        assert_eq!(error.code, "already_exists");
        assert_eq!(read_container(&destination).unwrap().0.name, "Imported");
        assert_eq!(
            copy_container(&source, &source).unwrap_err().code,
            "same_path"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn copy_container_rejects_invalid_source_without_creating_destination() {
        let dir = temp_dir("import-invalid");
        let source = dir.join("broken.pcbre");
        let destination = dir.join("copy.pcbre");
        fs::write(&source, b"not a project").unwrap();
        assert_eq!(
            copy_container(&source, &destination).unwrap_err().code,
            "corrupt_container"
        );
        assert!(!destination.exists());
        assert!(fs::read_dir(&dir).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".tmp")
        }));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn blob_referenced_twice_is_stored_once() {
        let dir = temp_dir("dedup");
        let hash = "cd".repeat(32);
        let mut doc = doc_with_asset(&hash);
        doc.components.push(crate::project::schema::Component {
            id: "c1".to_string(),
            board_id: "board-1".to_string(),
            refdes: "U1".to_string(),
            type_id: "ic".to_string(),
            shape: crate::project::schema::Shape::Rect {
                x: 0.0,
                y: 0.0,
                w: 5.0,
                h: 5.0,
            },
            status: crate::project::schema::ComponentStatus::Identified,
            locked: false,
            part_number: None,
            value: None,
            marking: None,
            pkg: None,
            manufacturer: None,
            notes: None,
            datasheet_url: None,
            datasheet_hash: Some(hash.clone()),
            image_hash: Some(hash.clone()),
            image_hashes: None,
            image_names: None,
            description: None,
            coordinate_space: None,
            mapping_tab_id: None,
        });
        let target = dir.join("project.pcbre");
        let mut blobs = BTreeMap::new();
        blobs.insert(
            hash.clone(),
            BlobSource::StagedFile(staged(&dir, &hash, b"shared")),
        );
        write_container(&target, &serde_json::to_string(&doc).unwrap(), &blobs).unwrap();
        let file = File::open(&target).unwrap();
        let archive = zip::ZipArchive::new(file).unwrap();
        assert_eq!(archive.len(), 2); // project.json + one blob
        let (_, blob_hashes) = read_container(&target).unwrap();
        assert_eq!(blob_hashes, vec![hash]);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn project_json_is_deflated_and_blobs_are_stored() {
        let dir = temp_dir("methods");
        let hash = "ef".repeat(32);
        let doc = doc_with_asset(&hash);
        let target = dir.join("project.pcbre");
        let mut blobs = BTreeMap::new();
        blobs.insert(
            hash.clone(),
            BlobSource::StagedFile(staged(&dir, &hash, b"0123456789")),
        );
        write_container(&target, &serde_json::to_string(&doc).unwrap(), &blobs).unwrap();
        let file = File::open(&target).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let json_method = archive.by_name(PROJECT_JSON_ENTRY).unwrap().compression();
        assert_eq!(json_method, CompressionMethod::Deflated);
        let blob_method = archive
            .by_name(&format!("{BLOB_DIR}/{hash}"))
            .unwrap()
            .compression();
        assert_eq!(blob_method, CompressionMethod::Stored);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rename_replaces_existing_file_without_tmp_leftovers() {
        let dir = temp_dir("atomic");
        let hash = "11".repeat(32);
        let doc = doc_with_asset(&hash);
        let target = dir.join("project.pcbre");
        let mut blobs = BTreeMap::new();
        blobs.insert(
            hash.clone(),
            BlobSource::StagedFile(staged(&dir, &hash, b"first")),
        );
        write_container(&target, &serde_json::to_string(&doc).unwrap(), &blobs).unwrap();
        let first_size = fs::metadata(&target).unwrap().len();
        blobs.insert(
            hash.clone(),
            BlobSource::StagedFile(staged(&dir, &hash, b"second-version")),
        );
        write_container(&target, &serde_json::to_string(&doc).unwrap(), &blobs).unwrap();
        assert!(fs::metadata(&target).unwrap().len() != first_size);
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temporary files left behind");
        assert!(read_container(&target).is_ok());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn failure_cleans_up_the_temp_file_and_keeps_the_target() {
        let dir = temp_dir("failure");
        let hash = "22".repeat(32);
        let doc = doc_with_asset(&hash);
        let target = dir.join("project.pcbre");
        let mut blobs = BTreeMap::new();
        blobs.insert(
            hash.clone(),
            BlobSource::StagedFile(staged(&dir, &hash, b"first")),
        );
        write_container(&target, &serde_json::to_string(&doc).unwrap(), &blobs).unwrap();
        let before = fs::read(&target).unwrap();

        let missing = "33".repeat(32);
        let mut failing = BTreeMap::new();
        failing.insert(
            missing.clone(),
            BlobSource::StagedFile(dir.join("staging").join(&missing)),
        );
        let error = write_container(&target, "not important", &failing).unwrap_err();
        assert_eq!(error.code, "missing_blob");
        assert_eq!(fs::read(&target).unwrap(), before);
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temporary files left behind");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rename_failure_cleans_up_the_temp_file() {
        let dir = temp_dir("rename-fail");
        // A directory as the target makes the final rename fail (Windows and
        // Unix both refuse file→dir renames), which exercises the unified
        // cleanup path after the temp file was already written and synced —
        // without having to force a real fsync failure.
        let target = dir.join("project.pcbre");
        fs::create_dir(&target).unwrap();
        let error = write_container(&target, "{}", &BTreeMap::new()).unwrap_err();
        assert_eq!(error.code, "save_failed");
        assert!(target.is_dir(), "the existing target must be untouched");
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temporary files left behind");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn blobs_stream_copy_from_an_existing_container() {
        let dir = temp_dir("zip-source");
        let hash = "44".repeat(32);
        let doc = doc_with_asset(&hash);
        let first = dir.join("first.pcbre");
        let mut blobs = BTreeMap::new();
        blobs.insert(
            hash.clone(),
            BlobSource::StagedFile(staged(&dir, &hash, b"copied-bytes")),
        );
        write_container(&first, &serde_json::to_string(&doc).unwrap(), &blobs).unwrap();

        // Save the same doc to a second path, sourcing bytes only from the first zip.
        let second = dir.join("second.pcbre");
        let mut sourced = BTreeMap::new();
        sourced.insert(hash.clone(), BlobSource::ZipEntry(first.clone()));
        write_container(&second, &serde_json::to_string(&doc).unwrap(), &sourced).unwrap();
        let (loaded, blob_hashes) = read_container(&second).unwrap();
        assert_eq!(loaded, doc);
        assert_eq!(blob_hashes, vec![hash]);

        let error = {
            let missing = "55".repeat(32);
            let mut bad = BTreeMap::new();
            bad.insert(missing.clone(), BlobSource::ZipEntry(first.clone()));
            write_container(&second, "{}", &bad).unwrap_err()
        };
        assert_eq!(error.code, "missing_blob");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn truncated_zip_reports_corrupt_container() {
        let dir = temp_dir("truncated");
        let hash = "66".repeat(32);
        let doc = doc_with_asset(&hash);
        let target = dir.join("project.pcbre");
        let mut blobs = BTreeMap::new();
        blobs.insert(
            hash.clone(),
            BlobSource::StagedFile(staged(&dir, &hash, b"payload")),
        );
        write_container(&target, &serde_json::to_string(&doc).unwrap(), &blobs).unwrap();
        let full = fs::read(&target).unwrap();
        fs::write(&target, &full[..full.len() / 2]).unwrap();
        let error = read_container(&target).unwrap_err();
        assert_eq!(error.code, "corrupt_container");
        fs::write(&target, b"not a zip at all").unwrap();
        assert_eq!(
            read_container(&target).unwrap_err().code,
            "corrupt_container"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unsupported_schema_version_is_typed() {
        let dir = temp_dir("schema");
        let target = dir.join("project.pcbre");
        let future = r#"{"schemaVersion":9,"name":"x","createdAt":"t","updatedAt":"t","types":[],"boards":[],"components":[],"assets":{}}"#.to_string();
        write_container(&target, &future, &BTreeMap::new()).unwrap();
        let error = read_container(&target).unwrap_err();
        assert_eq!(error.code, "unsupported_schema_version");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn empty_assets_map_survives_round_trip() {
        let dir = temp_dir("empty");
        let target = dir.join("project.pcbre");
        let doc = new_doc("Empty", "2026-11-15T00:00:00Z");
        write_container(
            &target,
            &serde_json::to_string(&doc).unwrap(),
            &BTreeMap::new(),
        )
        .unwrap();
        let (loaded, blob_hashes) = read_container(&target).unwrap();
        assert_eq!(loaded.assets, HashMap::new());
        assert!(blob_hashes.is_empty());
        fs::remove_dir_all(&dir).ok();
    }
}
