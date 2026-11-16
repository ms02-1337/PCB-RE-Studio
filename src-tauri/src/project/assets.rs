//! Content-addressed asset staging: files are streamed, hashed with SHA-256,
//! and copied into `<cache>/pcb-re-studio/staging/<hash>`.

use crate::project::error::{ProjectError, ProjectResult};
use crate::project::schema::{is_valid_hash, AssetInfo};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};

const CHUNK: usize = 128 * 1024;

pub fn staging_root(app_cache_dir: &Path) -> PathBuf {
    app_cache_dir.join("pcb-re-studio").join("staging")
}

/// Removes every staged file. Used on startup and when a project closes.
pub fn clear_staging(root: &Path) -> io::Result<()> {
    match fs::remove_dir_all(root) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

/// Deletes staged files whose hashes are not in `keep`.
pub fn gc_staging(root: &Path, keep: &HashSet<String>) -> io::Result<()> {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    for entry in entries.filter_map(|entry| entry.ok()) {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !keep.contains(&name) {
            fs::remove_file(entry.path()).ok();
        }
    }
    Ok(())
}

/// Streams `source`, hashing it with SHA-256. Returns the lowercase hex digest
/// and the byte count.
pub fn hash_file(source: &Path) -> ProjectResult<(String, u64)> {
    let mut file = File::open(source).map_err(|error| {
        ProjectError::asset_unreadable(format!("{}: {error}", source.display()))
    })?;
    let mut hasher = Sha256::new();
    let mut size: u64 = 0;
    let mut buffer = vec![0u8; CHUNK];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| ProjectError::asset_unreadable(error.to_string()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        size += read as u64;
    }
    Ok((format!("{:x}", hasher.finalize()), size))
}

/// Streams and hashes an asset, staging it only when its content is neither in
/// `known` (hashes already available to the open project) nor staged already.
/// Returns the asset index entry for the doc.
pub fn stage_asset(
    source: &Path,
    root: &Path,
    known: &HashSet<String>,
) -> ProjectResult<AssetInfo> {
    let (hash, size) = hash_file(source)?;
    if !is_valid_hash(&hash) {
        return Err(ProjectError::asset_unreadable("unexpected hash digest"));
    }
    let name = source
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "asset".to_string());
    let staged = root.join(&hash);
    if !known.contains(&hash) && !staged.is_file() {
        fs::create_dir_all(root)?;
        let temp = root.join(format!("{hash}.staging"));
        let copied = fs::copy(source, &temp).map_err(|error| {
            ProjectError::asset_unreadable(format!("{}: {error}", source.display()))
        })?;
        if copied != size {
            let _ = fs::remove_file(&temp);
            return Err(ProjectError::asset_unreadable(
                "the asset changed while it was being imported",
            ));
        }
        if let Err(error) = fs::rename(&temp, &staged) {
            let _ = fs::remove_file(&temp);
            return Err(ProjectError::asset_unreadable(error.to_string()));
        }
    }
    Ok(AssetInfo { hash, size, name })
}

/// Reads a staged blob fully into memory (whole-blob reads are accepted for v1).
pub fn read_staged(root: &Path, hash: &str) -> Option<Vec<u8>> {
    if !is_valid_hash(hash) {
        return None;
    }
    fs::read(root.join(hash)).ok()
}

/// Extracts one blob from a project container without inflating everything.
pub fn read_from_container(zip_path: &Path, hash: &str) -> Option<Vec<u8>> {
    if !is_valid_hash(hash) {
        return None;
    }
    let file = File::open(zip_path).ok()?;
    let mut archive = zip::ZipArchive::new(file).ok()?;
    let mut entry = archive.by_name(&format!("blobs/{hash}")).ok()?;
    let mut bytes = Vec::new();
    entry.read_to_end(&mut bytes).ok()?;
    Some(bytes)
}

/// Streams one blob out to `dest`, preferring staging over the project zip.
pub fn export_blob(
    hash: &str,
    dest: &Path,
    root: &Path,
    open_zip: Option<&Path>,
) -> ProjectResult<()> {
    if !is_valid_hash(hash) {
        return Err(ProjectError::missing_blob(hash));
    }
    let staged = root.join(hash);
    if staged.is_file() {
        fs::copy(&staged, dest).map_err(|error| {
            ProjectError::with_detail(
                "export_failed",
                "The asset could not be exported.",
                error.to_string(),
            )
        })?;
        return Ok(());
    }
    if let Some(zip_path) = open_zip {
        let bytes = read_from_container(zip_path, hash);
        if let Some(bytes) = bytes {
            fs::write(dest, bytes).map_err(|error| {
                ProjectError::with_detail(
                    "export_failed",
                    "The asset could not be exported.",
                    error.to_string(),
                )
            })?;
            return Ok(());
        }
    }
    Err(ProjectError::missing_blob(hash))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "pcbre-assets-{tag}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sha_hex(bytes: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        format!("{:x}", hasher.finalize())
    }

    #[test]
    fn hashes_streaming_reads() {
        let dir = temp_dir("hash");
        let source = dir.join("asset.bin");
        fs::write(&source, vec![42u8; 300_000]).unwrap();
        let (hash, size) = hash_file(&source).unwrap();
        assert_eq!(hash, sha_hex(&vec![42u8; 300_000]));
        assert_eq!(size, 300_000);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn same_bytes_twice_stages_one_file() {
        let dir = temp_dir("dedup");
        let root = staging_root(&dir);
        let first = dir.join("a.png");
        let second = dir.join("b.png");
        fs::write(&first, b"identical-bytes").unwrap();
        fs::write(&second, b"identical-bytes").unwrap();
        let expected = sha_hex(b"identical-bytes");

        let info = stage_asset(&first, &root, &HashSet::new()).unwrap();
        assert_eq!(info.hash, expected);
        assert_eq!(info.name, "a.png");
        assert_eq!(info.size, 15);
        let again = stage_asset(&second, &root, &HashSet::new()).unwrap();
        assert_eq!(again.hash, expected);
        assert_eq!(again.name, "b.png");
        let staged: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .filter_map(|e| e.ok())
            .collect();
        assert_eq!(staged.len(), 1);
        assert_eq!(staged[0].file_name().to_string_lossy(), expected);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn known_hashes_skip_staging_entirely() {
        let dir = temp_dir("known");
        let root = staging_root(&dir);
        let source = dir.join("a.png");
        fs::write(&source, b"already-in-project").unwrap();
        let expected = sha_hex(b"already-in-project");
        let known: HashSet<String> = [expected.clone()].into_iter().collect();
        let info = stage_asset(&source, &root, &known).unwrap();
        assert_eq!(info.hash, expected);
        assert!(!root.join(&expected).is_file());
        assert!(fs::read_dir(&root).is_err());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn gc_removes_only_unreferenced_files() {
        let dir = temp_dir("gc");
        let root = staging_root(&dir);
        fs::create_dir_all(&root).unwrap();
        let keep_hash = "aa".repeat(32);
        let drop_hash = "bb".repeat(32);
        fs::write(root.join(&keep_hash), b"keep").unwrap();
        fs::write(root.join(&drop_hash), b"drop").unwrap();
        let keep: HashSet<String> = [keep_hash.clone()].into_iter().collect();
        gc_staging(&root, &keep).unwrap();
        assert!(root.join(&keep_hash).is_file());
        assert!(!root.join(&drop_hash).is_file());
        gc_staging(dir.join("missing-staging").as_path(), &keep).unwrap();
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn clear_removes_everything_and_is_idempotent() {
        let dir = temp_dir("clear");
        let root = staging_root(&dir);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("aa".repeat(32)), b"x").unwrap();
        clear_staging(&root).unwrap();
        assert!(!root.exists());
        clear_staging(&root).unwrap();
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn read_staged_rejects_malformed_hashes() {
        let dir = temp_dir("read");
        let root = staging_root(&dir);
        assert!(read_staged(&root, "../escape").is_none());
        assert!(read_staged(&root, "AA".repeat(32).as_str()).is_none());
        fs::remove_dir_all(&dir).ok();
    }
}
