//! App-managed local library for imported footprint and symbol files.
//!
//! Downloaded KiCad files are copied under the app data directory so they stay
//! usable after the original download is deleted. Files are fully parsed
//! before they are copied (unsupported geometry fails per file), identical
//! content is deduplicated, and entry identity matches source rescans.

use super::*;
use sha2::{Digest, Sha256};

pub const MAX_IMPORT_FILES: usize = 100;
pub const MAX_IMPORT_SYMBOLS: usize = 100;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOutcome {
    pub file: String,
    pub library: String,
    pub entries: Vec<LibraryEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub fn import_files(
    app_data: &Path,
    registry: &mut Registry,
    paths: &[String],
) -> ProjectResult<Vec<ImportOutcome>> {
    if paths.is_empty() {
        return Ok(vec![]);
    }
    if paths.len() > MAX_IMPORT_FILES {
        return Err(sexpr::error("Import at most 100 library files at once."));
    }
    let root = app_data.join(LOCAL_LIBRARY_DIR);
    fs::create_dir_all(root.join(LOCAL_FOOTPRINT_DIR))?;
    // Canonicalize so entry ids (hashes of path strings) match a later rescan
    // of the local source exactly.
    let root = root.canonicalize()?;
    let mut outcomes = vec![];
    let mut imported: Vec<LibraryEntry> = vec![];
    for path in paths {
        let file = PathBuf::from(path);
        let file_name = file
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        match import_one(&root, &file) {
            Ok((library, entries)) => {
                imported.extend(entries.iter().cloned());
                outcomes.push(ImportOutcome {
                    file: file_name,
                    library,
                    entries,
                    error: None,
                });
            }
            Err(e) => outcomes.push(ImportOutcome {
                file: file_name,
                library: String::new(),
                entries: vec![],
                error: Some(e.to_string()),
            }),
        }
    }
    if !imported.is_empty() {
        ensure_local_source(&root, registry);
        let ids: std::collections::HashSet<_> = imported.iter().map(|e| e.id.clone()).collect();
        registry
            .entries
            .retain(|e| !(e.source_id == LOCAL_SOURCE_ID && ids.contains(&e.id)));
        registry.entries.extend(imported);
    }
    Ok(outcomes)
}

fn import_one(root: &Path, path: &Path) -> ProjectResult<(String, Vec<LibraryEntry>)> {
    if !path.is_absolute() {
        return Err(ProjectError::invalid_path());
    }
    let path = path
        .canonicalize()
        .map_err(|e| sexpr::error(&format!("Import file is unreadable: {e}")))?;
    if !path.is_file() {
        return Err(sexpr::error("Import path is not a file."));
    }
    let extension = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    if extension != "kicad_mod" && extension != "kicad_sym" {
        return Err(sexpr::error(
            "Only .kicad_mod and .kicad_sym files can be imported.",
        ));
    }
    let raw = read(&path)?;
    validate(&raw, extension)?;
    let dest_dir = if extension == "kicad_mod" {
        root.join(LOCAL_FOOTPRINT_DIR)
    } else {
        root.to_path_buf()
    };
    let dest = choose_dest(&dest_dir, &path, raw.as_bytes())?;
    if !dest.exists() {
        atomic(&dest, raw.as_bytes())?;
    }
    let entries = index_file(LOCAL_SOURCE_ID, &dest, &raw)?;
    Ok((library_name(&dest), entries))
}

/// Fully parses an imported file so unsupported geometry fails at import time
/// instead of when the entry is used.
fn validate(raw: &str, extension: &str) -> ProjectResult<()> {
    if extension == "kicad_mod" {
        parser::footprint(raw, "import")?;
        return Ok(());
    }
    let names = parser::symbol_names(raw)?;
    if names.len() > MAX_IMPORT_SYMBOLS {
        return Err(sexpr::error(&format!(
            "Symbol file has {} symbols; the import limit is {MAX_IMPORT_SYMBOLS}. Register large libraries as a source instead.",
            names.len()
        )));
    }
    for name in &names {
        parser::symbol(raw, name, "import")?;
    }
    Ok(())
}

fn choose_dest(dir: &Path, source: &Path, bytes: &[u8]) -> ProjectResult<PathBuf> {
    let name = source
        .file_name()
        .ok_or_else(|| sexpr::error("Import file has no name."))?;
    let candidate = dir.join(name);
    if !candidate.exists() || same_content(&candidate, bytes)? {
        return Ok(candidate);
    }
    // Same name with different bytes: keep both under a deterministic
    // content-hash suffix (identical content maps to the same name).
    let stem = source
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let extension = source
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default();
    let short = format!("{:x}", Sha256::digest(bytes))[..8].to_string();
    let mut counter = 0u32;
    let candidate = loop {
        counter += 1;
        let suffix = if counter == 1 {
            short.clone()
        } else {
            format!("{short}-{counter}")
        };
        let candidate = dir.join(format!("{stem}-{suffix}.{extension}"));
        if !candidate.exists() || same_content(&candidate, bytes)? {
            break candidate;
        }
    };
    Ok(candidate)
}

fn same_content(path: &Path, bytes: &[u8]) -> ProjectResult<bool> {
    Ok(fs::read(path)
        .map(|existing| existing == bytes)
        .unwrap_or(false))
}

fn library_name(dest: &Path) -> String {
    if dest.extension().is_some_and(|e| e == "kicad_mod") {
        dest.parent()
            .and_then(Path::file_name)
            .map(|n| n.to_string_lossy().trim_end_matches(".pretty").to_string())
            .unwrap_or_default()
    } else {
        dest.file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default()
    }
}

pub fn ensure_local_source(root: &Path, registry: &mut Registry) {
    let path = root.to_string_lossy().into_owned();
    if let Some(source) = registry
        .sources
        .iter_mut()
        .find(|s| s.id == LOCAL_SOURCE_ID)
    {
        source.path = path;
        return;
    }
    registry.sources.push(LibrarySource {
        id: LOCAL_SOURCE_ID.into(),
        path,
        name: LOCAL_SOURCE_NAME.into(),
        diagnostics: vec![],
        variables: HashMap::new(),
        local: true,
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const FOOTPRINT: &str = r#"(footprint "R_0603" (attr smd)
        (pad "1" smd rect (at -0.775 0) (size 0.8 0.9) (layers "F.Cu" "F.Paste" "F.Mask"))
        (pad "2" smd rect (at 0.775 0) (size 0.8 0.9) (layers "F.Cu" "F.Paste" "F.Mask")))"#;
    const SYMBOL: &str = r#"(kicad_symbol_lib (symbol "R" (property "Reference" "R" (at 0 0 0))
        (symbol "R_1_1" (pin passive line (at 0 0 270) (length 2.54) (name "A") (number "1")))))"#;

    fn workspace(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "pcbre-import-{tag}-{}",
            parser::hash(&format!("{tag}-{:?}", std::time::SystemTime::now()))
        ));
        fs::create_dir_all(dir.join("downloads")).unwrap();
        dir
    }
    fn download(dir: &Path, name: &str, text: &str) -> String {
        let path = dir.join("downloads").join(name);
        fs::write(&path, text).unwrap();
        path.to_string_lossy().into_owned()
    }
    fn local_entries(registry: &Registry) -> Vec<&LibraryEntry> {
        registry
            .entries
            .iter()
            .filter(|e| e.source_id == LOCAL_SOURCE_ID)
            .collect()
    }

    #[test]
    fn imports_footprint_and_symbol_files_into_local_library() {
        let dir = workspace("basic");
        let footprint = download(&dir, "R_0603.kicad_mod", FOOTPRINT);
        let symbol = download(&dir, "Device.kicad_sym", SYMBOL);
        let mut registry = Registry::default();
        let outcomes = import_files(&dir, &mut registry, &[footprint, symbol]).unwrap();
        assert!(outcomes.iter().all(|o| o.error.is_none()));
        assert_eq!(outcomes[0].library, "Imported");
        assert_eq!(outcomes[1].library, "Device");
        let root = dir.join(LOCAL_LIBRARY_DIR).canonicalize().unwrap();
        assert_eq!(
            outcomes[0].entries[0].path,
            root.join(LOCAL_FOOTPRINT_DIR)
                .join("R_0603.kicad_mod")
                .canonicalize()
                .unwrap()
                .to_string_lossy()
                .into_owned()
        );
        let source = registry.sources.iter().find(|s| s.local).unwrap();
        assert_eq!(source.id, LOCAL_SOURCE_ID);
        assert_eq!(source.name, LOCAL_SOURCE_NAME);
        let entries = local_entries(&registry);
        assert_eq!(entries.len(), 2);
        assert!(entries.iter().any(|e| e.kind == "footprint"
            && e.name == "Imported:R_0603"
            && e.id == parser::hash(&e.path)));
        assert!(entries.iter().any(|e| e.kind == "symbol"
            && e.name == "Device:R"
            && e.symbol_name.as_deref() == Some("R")
            && e.id == parser::hash(&format!("{}::R", e.path))));
        // Files load from the local copies, not the downloads.
        assert!(
            parser::footprint(&read(Path::new(&entries[0].path)).unwrap(), "import")
                .unwrap()
                .pads
                .len()
                == 2
        );
    }

    #[test]
    fn reimport_is_idempotent() {
        let dir = workspace("dedupe");
        let footprint = download(&dir, "R_0603.kicad_mod", FOOTPRINT);
        let mut registry = Registry::default();
        import_files(&dir, &mut registry, &[footprint.clone()]).unwrap();
        let first: Vec<LibraryEntry> = local_entries(&registry).into_iter().cloned().collect();
        let outcomes = import_files(&dir, &mut registry, &[footprint]).unwrap();
        assert!(outcomes[0].error.is_none());
        assert_eq!(outcomes[0].entries.len(), first.len());
        assert_eq!(local_entries(&registry).len(), first.len());
        assert_eq!(registry.sources.len(), 1);
    }

    #[test]
    fn same_name_different_content_coexists_by_hash() {
        let dir = workspace("collision");
        // Simulate re-downloading an updated file under the same name.
        let path = dir.join("downloads").join("R.kicad_mod");
        fs::write(&path, FOOTPRINT).unwrap();
        let mut registry = Registry::default();
        import_files(&dir, &mut registry, &[path.to_string_lossy().into_owned()]).unwrap();
        let updated = FOOTPRINT.replace("R_0603", "R_0805");
        fs::write(&path, &updated).unwrap();
        import_files(&dir, &mut registry, &[path.to_string_lossy().into_owned()]).unwrap();
        let entries = local_entries(&registry);
        assert_eq!(entries.len(), 2);
        assert_ne!(entries[0].id, entries[1].id);
        let root = dir.join(LOCAL_LIBRARY_DIR).canonicalize().unwrap();
        let suffix = format!("{:x}", Sha256::digest(updated.as_bytes()))[..8].to_string();
        assert!(entries
            .iter()
            .any(|e| e.path.ends_with(&format!("R-{suffix}.kicad_mod"))));
        assert!(root.join(LOCAL_FOOTPRINT_DIR).join("R.kicad_mod").is_file());
    }

    #[test]
    fn rejects_unsupported_geometry_without_copying() {
        let dir = workspace("invalid");
        let bad = download(
            &dir,
            "Bad.kicad_mod",
            r#"(footprint "Bad" (pad "1" smd trapezoid (size 1 1) (layers "F.Cu")))"#,
        );
        let mut registry = Registry::default();
        let outcomes = import_files(&dir, &mut registry, &[bad]).unwrap();
        assert!(outcomes[0].error.is_some());
        assert!(local_entries(&registry).is_empty());
        assert!(registry.sources.is_empty());
        assert!(!dir
            .join(LOCAL_LIBRARY_DIR)
            .join(LOCAL_FOOTPRINT_DIR)
            .join("Bad.kicad_mod")
            .exists());
    }

    #[test]
    fn rejects_non_files_and_wrong_extensions_per_file() {
        let dir = workspace("paths");
        let text = download(&dir, "notes.txt", "hello");
        let mut registry = Registry::default();
        let outcomes = import_files(
            &dir,
            &mut registry,
            &[
                dir.to_string_lossy().into_owned(),
                "relative.kicad_mod".into(),
                text,
            ],
        )
        .unwrap();
        assert_eq!(outcomes.len(), 3);
        assert!(outcomes.iter().all(|o| o.error.is_some()));
        assert!(registry.sources.is_empty());
    }

    #[test]
    fn import_entries_match_a_later_rescan_of_the_local_source() {
        let dir = workspace("rescan");
        let footprint = download(&dir, "R_0603.kicad_mod", FOOTPRINT);
        let symbol = download(&dir, "Device.kicad_sym", SYMBOL);
        let mut registry = Registry::default();
        import_files(&dir, &mut registry, &[footprint, symbol]).unwrap();
        let source = registry.sources.iter().find(|s| s.local).unwrap().clone();
        let (files, diagnostics) = discover(&source, &|| false).unwrap();
        assert!(diagnostics.is_empty());
        let mut rescanned = vec![];
        for path in files {
            let raw = read(&path).unwrap();
            rescanned.extend(index_file(&source.id, &path, &raw).unwrap());
        }
        rescanned.sort_by(|a, b| a.id.cmp(&b.id));
        let mut imported: Vec<LibraryEntry> =
            local_entries(&registry).into_iter().cloned().collect();
        imported.sort_by(|a, b| a.id.cmp(&b.id));
        assert_eq!(imported, rescanned);
    }

    #[test]
    fn local_source_is_protected_from_removal() {
        let dir = workspace("protect");
        let footprint = download(&dir, "R_0603.kicad_mod", FOOTPRINT);
        let mut registry = Registry::default();
        import_files(&dir, &mut registry, &[footprint]).unwrap();
        assert!(remove_source(&mut registry, LOCAL_SOURCE_ID).is_err());
        assert!(registry.sources.iter().any(|s| s.local));
        assert!(!local_entries(&registry).is_empty());
        registry.sources.push(LibrarySource {
            id: "user".into(),
            path: dir.join("downloads").to_string_lossy().into_owned(),
            name: "Downloads".into(),
            diagnostics: vec![],
            variables: HashMap::new(),
            local: false,
        });
        assert!(remove_source(&mut registry, "user").is_ok());
    }
}
