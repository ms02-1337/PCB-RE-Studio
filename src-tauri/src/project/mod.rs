//! Project persistence domain: schema, container, and asset-store primitives.
//! Handlers in `crate::commands` stay thin; logic lives here.

pub mod assets;
pub mod clipboard;
pub mod container;
pub mod error;
pub mod html_export;
pub mod schema;

use crate::project::assets::{gc_staging, staging_root};
use crate::project::container::{read_container, write_container, BlobSource};
use crate::project::error::{ProjectError, ProjectResult};
use crate::project::schema::{referenced_hashes, validate, ProjectDoc};
use std::collections::{BTreeMap, HashSet};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveOutcome {
    pub path: String,
    pub bytes: u64,
    pub blob_count: usize,
    pub saved_at: String,
}

/// UTC RFC 3339 timestamp with second precision, no external crates.
pub fn rfc3339(unix_seconds: i64) -> String {
    let days = unix_seconds.div_euclid(86_400);
    let seconds_of_day = unix_seconds.rem_euclid(86_400);
    let (hour, minute, second) = (
        seconds_of_day / 3_600,
        (seconds_of_day % 3_600) / 60,
        seconds_of_day % 60,
    );
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let mp = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year + 1 } else { year };
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

pub fn now_rfc3339() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0);
    rfc3339(seconds)
}

/// Validates the incoming doc, GCs its asset index to the referenced set,
/// sources each blob (staging first, then the previously open container),
/// writes the container atomically, then GCs unreferenced staging files.
/// On success `doc` reflects exactly what was written: `updated_at` bumped and
/// unreferenced asset index entries pruned.
pub fn save_doc(
    doc: &mut ProjectDoc,
    target: &Path,
    previous_zip: Option<&Path>,
    asset_staging_root: &Path,
    now: &str,
) -> ProjectResult<SaveOutcome> {
    validate(doc)?;
    doc.updated_at = now.to_string();
    let referenced = referenced_hashes(doc);
    let keep: HashSet<String> = referenced.iter().cloned().collect();
    doc.assets.retain(|hash, _| keep.contains(hash));

    let mut blobs = BTreeMap::new();
    for hash in &referenced {
        let staged = asset_staging_root.join(hash);
        if staged.is_file() {
            blobs.insert(hash.clone(), BlobSource::StagedFile(staged));
        } else if let Some(zip) = previous_zip {
            blobs.insert(hash.clone(), BlobSource::ZipEntry(zip.to_path_buf()));
        } else {
            return Err(ProjectError::missing_blob(hash));
        }
    }
    let json = crate::kicad::codec::encode(doc).map_err(|error| {
        ProjectError::save_failed(format!("could not encode project.json: {error}"))
    })?;
    let bytes = write_container(target, &json, &blobs)?;
    gc_staging(asset_staging_root, &keep).ok();
    Ok(SaveOutcome {
        path: target.to_string_lossy().into_owned(),
        bytes,
        blob_count: referenced.len(),
        saved_at: now.to_string(),
    })
}

/// Loads and validates a container, returning the doc plus the hashes present.
pub fn load_doc(path: &Path) -> ProjectResult<(ProjectDoc, Vec<String>)> {
    read_container(path)
}

/// Convenience for tests and handlers: staging path under an app cache dir.
pub fn staging_for(app_cache_dir: &Path) -> std::path::PathBuf {
    staging_root(app_cache_dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::assets::{clear_staging, stage_asset};
    use crate::project::schema::{
        new_doc, AssetInfo, Board, Component, ComponentStatus, Point, Shape,
    };
    use std::collections::HashMap;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "pcbre-save-{tag}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn hash_of(bytes: &[u8]) -> String {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        format!("{:x}", hasher.finalize())
    }

    fn doc_with_boards(now: &str, boards: &[(&str, &str, u32, u32)]) -> ProjectDoc {
        let mut doc = new_doc("Save fixtures", now);
        for (id, hash, width, height) in boards {
            doc.assets.insert(
                (*hash).to_string(),
                AssetInfo {
                    hash: (*hash).to_string(),
                    size: 4,
                    name: format!("{id}.png"),
                },
            );
            doc.boards.push(Board::plain(id, id, hash, *width, *height));
        }
        doc.active_board_id = doc.boards.first().map(|board| board.id.clone());
        doc
    }

    #[test]
    fn formats_known_and_current_timestamps() {
        assert_eq!(rfc3339(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339(1_000_000_000), "2001-09-09T01:46:40Z");
        assert_eq!(rfc3339(1_763_164_800), "2025-11-15T00:00:00Z");
        assert_eq!(rfc3339(951_782_400), "2000-02-29T00:00:00Z");
        let now = now_rfc3339();
        assert_eq!(now.len(), 20);
        assert!(now.ends_with('Z'));
    }

    #[test]
    fn gc_keeps_only_referenced_blobs() {
        let dir = temp_dir("gc");
        let staging = dir.join("staging");
        let target = dir.join("project.pcbre");
        let a_hash = hash_of(b"board-a");
        let b_hash = hash_of(b"board-b");
        fs::write(dir.join("a.png"), b"board-a").unwrap();
        fs::write(dir.join("b.png"), b"board-b").unwrap();
        stage_asset(&dir.join("a.png"), &staging, &HashSet::new()).unwrap();
        stage_asset(&dir.join("b.png"), &staging, &HashSet::new()).unwrap();

        let now = "2026-11-15T00:00:00Z";
        let mut both = doc_with_boards(now, &[("a", &a_hash, 4, 4), ("b", &b_hash, 4, 4)]);
        let outcome = save_doc(&mut both, &target, None, &staging, now).unwrap();
        assert_eq!(outcome.blob_count, 2);
        let (_, hashes) = load_doc(&target).unwrap();
        assert_eq!(hashes.len(), 2);

        let mut only_a = doc_with_boards(now, &[("a", &a_hash, 4, 4)]);
        let outcome = save_doc(&mut only_a, &target, Some(&target), &staging, now).unwrap();
        assert_eq!(outcome.blob_count, 1);
        let (_, hashes) = load_doc(&target).unwrap();
        assert_eq!(hashes, vec![a_hash.clone()]);
        assert!(staging.join(&a_hash).is_file());
        assert!(!staging.join(&b_hash).is_file());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn staging_is_cleared_on_startup() {
        let dir = temp_dir("startup");
        let staging = staging_for(&dir);
        fs::create_dir_all(&staging).unwrap();
        fs::write(staging.join("aa".repeat(32)), b"left over").unwrap();
        clear_staging(&staging).unwrap();
        assert!(!staging.exists());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn hundred_duplicates_store_bytes_once() {
        let dir = temp_dir("hundred");
        let staging = dir.join("staging");
        let target = dir.join("project.pcbre");
        let image_hash = hash_of(b"chip-photo");
        fs::write(dir.join("chip.png"), b"chip-photo").unwrap();
        stage_asset(&dir.join("chip.png"), &staging, &HashSet::new()).unwrap();
        fs::write(dir.join("board.png"), b"board").unwrap();
        let board_info = stage_asset(&dir.join("board.png"), &staging, &HashSet::new()).unwrap();

        let now = "2026-11-15T00:00:00Z";
        let mut doc = new_doc("Many duplicates", now);
        doc.assets
            .insert(board_info.hash.clone(), board_info.clone());
        doc.boards
            .push(Board::plain("board-1", "Front", &board_info.hash, 64, 64));
        doc.active_board_id = Some("board-1".to_string());
        let mut assets = HashMap::new();
        assets.insert(
            image_hash.clone(),
            AssetInfo {
                hash: image_hash.clone(),
                size: 9,
                name: "chip.png".to_string(),
            },
        );
        doc.assets.extend(assets);
        for index in 0..100 {
            doc.components.push(Component {
                id: format!("c{index}"),
                board_id: "board-1".to_string(),
                refdes: format!("U{}", index + 1),
                type_id: "ic".to_string(),
                shape: Shape::Rect {
                    x: index as f64,
                    y: 0.0,
                    w: 10.0,
                    h: 10.0,
                },
                status: ComponentStatus::Identified,
                locked: false,
                part_number: None,
                value: None,
                marking: None,
                pkg: None,
                manufacturer: None,
                notes: None,
                datasheet_url: None,
                datasheet_hash: None,
                image_hash: Some(image_hash.clone()),
                image_hashes: None,
                image_names: None,
                description: None,
                coordinate_space: None,
                mapping_tab_id: None,
            });
        }
        let outcome = save_doc(&mut doc, &target, None, &staging, now).unwrap();
        assert_eq!(outcome.blob_count, 2); // board + one shared image
        let file = fs::File::open(&target).unwrap();
        let archive = zip::ZipArchive::new(file).unwrap();
        assert_eq!(archive.len(), 3); // project.json + 2 blobs
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn save_bumps_updated_at_and_prunes_index() {
        let dir = temp_dir("bump");
        let staging = dir.join("staging");
        let target = dir.join("project.pcbre");
        let hash = hash_of(b"board");
        fs::write(dir.join("board.png"), b"board").unwrap();
        let info = stage_asset(&dir.join("board.png"), &staging, &HashSet::new()).unwrap();
        assert_eq!(info.hash, hash);

        let now = "2026-11-15T12:00:00Z";
        let mut doc = doc_with_boards(now, &[("board-1", &hash, 8, 8)]);
        // An asset index entry nothing references must be pruned on save.
        let orphan = hash_of(b"orphan");
        doc.assets.insert(
            orphan.clone(),
            AssetInfo {
                hash: orphan.clone(),
                size: 6,
                name: "orphan.png".to_string(),
            },
        );
        save_doc(&mut doc, &target, None, &staging, "2026-11-15T13:00:00Z").unwrap();
        let (loaded, hashes) = load_doc(&target).unwrap();
        assert_eq!(loaded.updated_at, "2026-11-15T13:00:00Z");
        assert_eq!(loaded.created_at, now);
        assert!(!loaded.assets.contains_key(&orphan));
        assert_eq!(hashes, vec![hash]);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_blob_and_invalid_docs_are_typed_errors() {
        let dir = temp_dir("errors");
        let staging = dir.join("staging");
        let target = dir.join("project.pcbre");
        let now = "2026-11-15T00:00:00Z";
        let mut doc = doc_with_boards(now, &[("board-1", &"99".repeat(32), 8, 8)]);
        let error = save_doc(&mut doc, &target, None, &staging, now).unwrap_err();
        assert_eq!(error.code, "missing_blob");

        let mut invalid = new_doc("Bad", now);
        invalid.components.push(Component {
            id: "c1".to_string(),
            board_id: "missing-board".to_string(),
            refdes: "".to_string(),
            type_id: "ic".to_string(),
            shape: Shape::Polygon {
                points: vec![Point { x: 0.0, y: 0.0 }, Point { x: 1.0, y: 0.0 }],
            },
            status: ComponentStatus::Identified,
            locked: false,
            part_number: None,
            value: None,
            marking: None,
            pkg: None,
            manufacturer: None,
            notes: None,
            datasheet_url: None,
            datasheet_hash: None,
            image_hash: None,
            image_hashes: None,
            image_names: None,
            description: None,
            coordinate_space: None,
            mapping_tab_id: None,
        });
        let error = save_doc(&mut invalid, &target, None, &staging, now).unwrap_err();
        assert_eq!(error.code, "invalid_data");
        assert!(!target.exists());
        fs::remove_dir_all(&dir).ok();
    }
}
