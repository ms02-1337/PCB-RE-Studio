use super::*;
use tauri::Manager;
fn registry<T>(
    app: &tauri::AppHandle,
    change: impl FnOnce(&mut Registry) -> ProjectResult<T>,
    write: bool,
) -> ProjectResult<T> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| sexpr::error(&e.to_string()))?
        .join("kicad-library.json");
    let state = app.state::<LibraryState>();
    let mut guard = state
        .registry
        .lock()
        .map_err(|_| sexpr::error("Library state unavailable."))?;
    if guard.is_none() {
        *guard = Some(load(&path)?);
    }
    if write {
        let mut candidate = guard.as_ref().unwrap().clone();
        let result = change(&mut candidate)?;
        save(&path, &candidate)?;
        *guard = Some(candidate);
        Ok(result)
    } else {
        change(guard.as_mut().unwrap())
    }
}
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> ProjectResult<T> + Send + 'static,
) -> ProjectResult<T> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| sexpr::error(&e.to_string()))?
}
#[tauri::command]
pub async fn kicad_sources(app: tauri::AppHandle) -> ProjectResult<Vec<LibrarySource>> {
    blocking(move || registry(&app, |r| Ok(r.sources.clone()), false)).await
}
#[tauri::command]
pub async fn kicad_add_source(
    app: tauri::AppHandle,
    path: String,
    variables: HashMap<String, String>,
) -> ProjectResult<LibrarySource> {
    blocking(move || {
        let p = PathBuf::from(&path);
        if !p.is_absolute() {
            return Err(ProjectError::invalid_path());
        }
        let path = p.canonicalize()?;
        let name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        let path = path.to_string_lossy().into_owned();
        let source = LibrarySource {
            id: parser::hash(&path),
            path,
            name,
            diagnostics: vec![],
            variables,
        };
        registry(
            &app,
            |r| {
                r.sources.retain(|s| s.id != source.id);
                r.sources.push(source.clone());
                Ok(source)
            },
            true,
        )
    })
    .await
}
#[tauri::command]
pub async fn kicad_remove_source(app: tauri::AppHandle, id: String) -> ProjectResult<()> {
    blocking(move || {
        registry(
            &app,
            |r| {
                r.sources.retain(|s| s.id != id);
                r.entries.retain(|e| e.source_id != id);
                Ok(())
            },
            true,
        )
    })
    .await
}
#[tauri::command]
pub async fn kicad_rescan(app: tauri::AppHandle, source_id: String) -> ProjectResult<LibraryJob> {
    let source = {
        let app = app.clone();
        let source_id = source_id.clone();
        blocking(move || {
            registry(
                &app,
                |r| {
                    r.sources
                        .iter()
                        .find(|s| s.id == source_id)
                        .cloned()
                        .ok_or_else(|| sexpr::error("Unknown library source."))
                },
                false,
            )
        })
        .await?
    };
    let jobs = app.state::<LibraryState>().jobs.clone();
    let job = LibraryJob {
        id: format!(
            "{}-{}",
            source_id,
            parser::hash(&format!("{:?}", std::time::SystemTime::now()))
        ),
        status: "running".into(),
        scanned: 0,
        total: 0,
        error: None,
    };
    {
        let mut all = jobs
            .lock()
            .map_err(|_| sexpr::error("Library state unavailable."))?;
        for j in all.values_mut() {
            if j.id.starts_with(&source_id) && j.status == "running" {
                j.status = "cancelled".into();
            }
        }
        if all.len() > 64 {
            all.retain(|_, j| j.status == "running");
        }
        all.insert(job.id.clone(), job.clone());
    }
    let id = job.id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let cancelled = || {
            jobs.lock()
                .map_or(true, |j| j.get(&id).is_none_or(|j| j.status == "cancelled"))
        };
        let result = (|| {
            let (files, mut diagnostics) = discover(&source, &cancelled)?;
            if let Ok(mut j) = jobs.lock() {
                if let Some(j) = j.get_mut(&id) {
                    j.total = files.len();
                }
            }
            let mut entries = vec![];
            for (i, path) in files.iter().enumerate() {
                if cancelled() {
                    return Ok(());
                }
                let source_path = path.to_string_lossy().into_owned();
                match read(path) {
                    Ok(raw) => {
                        if path.extension().is_some_and(|e| e == "kicad_mod") {
                            entries.push(LibraryEntry {
                                id: parser::hash(&source_path),
                                name: path
                                    .file_stem()
                                    .unwrap_or_default()
                                    .to_string_lossy()
                                    .into_owned(),
                                source_id: source.id.clone(),
                                kind: "footprint".into(),
                                path: source_path,
                            });
                        } else {
                            match parser::symbol_names(&raw) {
                                Ok(names) => {
                                    for name in names {
                                        entries.push(LibraryEntry {
                                            id: parser::hash(&format!("{source_path}::{name}")),
                                            name,
                                            source_id: source.id.clone(),
                                            kind: "symbol".into(),
                                            path: source_path.clone(),
                                        });
                                    }
                                }
                                Err(e) => diagnostics.push(format!("{}: {e}", path.display())),
                            }
                        }
                    }
                    Err(e) => diagnostics.push(e.to_string()),
                }
                if let Ok(mut j) = jobs.lock() {
                    if let Some(j) = j.get_mut(&id) {
                        j.scanned = i + 1;
                    }
                }
            }
            if cancelled() {
                return Ok(());
            }
            registry(
                &app,
                |r| {
                    r.entries.retain(|e| e.source_id != source.id);
                    r.entries.extend(entries);
                    if let Some(s) = r.sources.iter_mut().find(|s| s.id == source.id) {
                        s.diagnostics = diagnostics;
                    }
                    Ok(())
                },
                true,
            )
        })();
        if let Ok(mut all) = jobs.lock() {
            if let Some(job) = all.get_mut(&id) {
                if job.status != "cancelled" {
                    match result {
                        Ok(()) => job.status = "done".into(),
                        Err(e) => {
                            job.status = "failed".into();
                            job.error = Some(e.to_string());
                        }
                    }
                }
            }
        }
    });
    Ok(job)
}
#[tauri::command]
pub fn kicad_job(state: tauri::State<'_, LibraryState>, id: String) -> ProjectResult<LibraryJob> {
    state
        .jobs
        .lock()
        .map_err(|_| sexpr::error("Library state unavailable."))?
        .get(&id)
        .cloned()
        .ok_or_else(|| sexpr::error("Unknown library job."))
}
#[tauri::command]
pub fn kicad_cancel(state: tauri::State<'_, LibraryState>, id: String) -> ProjectResult<()> {
    if let Some(job) = state
        .jobs
        .lock()
        .map_err(|_| sexpr::error("Library state unavailable."))?
        .get_mut(&id)
    {
        job.status = "cancelled".into();
    }
    Ok(())
}
#[derive(Serialize)]
pub struct LibraryPage {
    entries: Vec<LibraryEntry>,
    total: usize,
}
#[tauri::command]
pub async fn kicad_search(
    app: tauri::AppHandle,
    kind: String,
    query: String,
    offset: usize,
    limit: usize,
) -> ProjectResult<LibraryPage> {
    blocking(move || {
        registry(
            &app,
            |r| {
                let q = query.to_lowercase();
                let mut entries: Vec<_> = r
                    .entries
                    .iter()
                    .filter(|e| e.kind == kind && e.name.to_lowercase().contains(&q))
                    .cloned()
                    .collect();
                entries.sort_by(|a, b| a.name.cmp(&b.name));
                let total = entries.len();
                Ok(LibraryPage {
                    entries: entries
                        .into_iter()
                        .skip(offset)
                        .take(limit.min(500))
                        .collect(),
                    total,
                })
            },
            false,
        )
    })
    .await
}
#[tauri::command]
pub async fn kicad_footprint(app: tauri::AppHandle, id: String) -> ProjectResult<Footprint> {
    blocking(move || {
        let entry = registry(
            &app,
            |r| {
                r.entries
                    .iter()
                    .find(|e| e.id == id && e.kind == "footprint")
                    .cloned()
                    .ok_or_else(|| sexpr::error("Unknown footprint."))
            },
            false,
        )?;
        parser::footprint(&read(Path::new(&entry.path))?, &entry.name)
    })
    .await
}
#[tauri::command]
pub async fn kicad_symbol(app: tauri::AppHandle, id: String) -> ProjectResult<Symbol> {
    blocking(move || {
        let entry = registry(
            &app,
            |r| {
                r.entries
                    .iter()
                    .find(|e| e.id == id && e.kind == "symbol")
                    .cloned()
                    .ok_or_else(|| sexpr::error("Unknown symbol."))
            },
            false,
        )?;
        parser::symbol(&read(Path::new(&entry.path))?, &entry.name, &entry.name)
    })
    .await
}
#[tauri::command]
pub async fn kicad_definitions(app: tauri::AppHandle) -> ProjectResult<Vec<ComponentDefinition>> {
    blocking(move || registry(&app, |r| Ok(r.definitions.clone()), false)).await
}
#[tauri::command]
pub async fn kicad_save_definition(
    app: tauri::AppHandle,
    definition: ComponentDefinition,
) -> ProjectResult<()> {
    blocking(move || {
        validate_definition(&definition)?;
        registry(
            &app,
            |r| {
                r.definitions.retain(|d| d.id != definition.id);
                r.definitions.push(definition);
                Ok(())
            },
            true,
        )
    })
    .await
}
#[tauri::command]
pub async fn kicad_delete_definition(app: tauri::AppHandle, id: String) -> ProjectResult<()> {
    blocking(move || {
        registry(
            &app,
            |r| {
                r.definitions.retain(|d| d.id != id);
                Ok(())
            },
            true,
        )
    })
    .await
}
#[derive(Deserialize)]
pub struct ExportFile {
    pub name: String,
    pub text: String,
}
pub fn export_files(path: &Path, files: Vec<ExportFile>) -> ProjectResult<()> {
    if !path.is_absolute() {
        return Err(ProjectError::invalid_path());
    }
    if files.len() > 10000 || files.iter().map(|f| f.text.len()).sum::<usize>() > 128 * 1024 * 1024
    {
        return Err(sexpr::error("Export size limit exceeded."));
    }
    let mut names = std::collections::HashSet::new();
    for file in &files {
        if file.name.is_empty()
            || file.name.contains('\\')
            || file.name.contains(':')
            || Path::new(&file.name)
                .components()
                .any(|p| !matches!(p, std::path::Component::Normal(_)))
            || !names.insert(&file.name)
        {
            return Err(sexpr::error("Unsafe or duplicate export filename."));
        }
    }
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    use std::io::Write;
    for file in files {
        zip.start_file(file.name, zip::write::SimpleFileOptions::default())
            .map_err(|e| sexpr::error(&e.to_string()))?;
        zip.write_all(file.text.as_bytes())?;
    }
    let bytes = zip
        .finish()
        .map_err(|e| sexpr::error(&e.to_string()))?
        .into_inner();
    atomic(path, &bytes)
}
#[tauri::command]
pub async fn kicad_export_files(path: String, files: Vec<ExportFile>) -> ProjectResult<()> {
    blocking(move || export_files(Path::new(&path), files)).await
}
