pub mod codec;
pub mod commands;
pub mod parser;
pub mod sexpr;
pub mod types;
use crate::project::error::{ProjectError, ProjectResult};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use types::*;
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySource {
    pub id: String,
    pub path: String,
    pub name: String,
    pub diagnostics: Vec<String>,
    #[serde(default)]
    pub variables: HashMap<String, String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryEntry {
    pub id: String,
    pub name: String,
    pub source_id: String,
    pub kind: String,
    pub path: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryJob {
    pub id: String,
    pub status: String,
    pub scanned: usize,
    pub total: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
#[derive(Default, Clone, Serialize, Deserialize)]
pub struct Registry {
    pub sources: Vec<LibrarySource>,
    pub entries: Vec<LibraryEntry>,
    pub definitions: Vec<ComponentDefinition>,
}
#[derive(Default)]
pub struct LibraryState {
    pub registry: Mutex<Option<Registry>>,
    pub jobs: Arc<Mutex<HashMap<String, LibraryJob>>>,
}
pub fn load(path: &Path) -> ProjectResult<Registry> {
    if !path.exists() {
        return Ok(Registry::default());
    }
    if fs::metadata(path)?.len() > 128 * 1024 * 1024 {
        return Err(sexpr::error("Library registry exceeds size limit."));
    }
    serde_json::from_reader(fs::File::open(path)?).map_err(|e| sexpr::error(&e.to_string()))
}
pub fn save(path: &Path, registry: &Registry) -> ProjectResult<()> {
    let text = serde_json::to_vec(registry).map_err(|e| sexpr::error(&e.to_string()))?;
    atomic(path, &text)
}
pub fn atomic(path: &Path, bytes: &[u8]) -> ProjectResult<()> {
    let parent = path.parent().ok_or_else(ProjectError::invalid_path)?;
    fs::create_dir_all(parent)?;
    let tmp = parent.join(format!(
        ".pcbre-kicad-{}.tmp",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    let result = (|| {
        use std::io::Write;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result.map_err(ProjectError::from)
}
pub fn read(path: &Path) -> ProjectResult<String> {
    if fs::metadata(path)?.len() > 64 * 1024 * 1024 {
        return Err(sexpr::error("Library file exceeds 64 MiB."));
    }
    Ok(fs::read_to_string(path)?)
}
pub fn discover(
    source: &LibrarySource,
    cancel: &impl Fn() -> bool,
) -> ProjectResult<(Vec<PathBuf>, Vec<String>)> {
    let mut files = vec![];
    let mut diagnostics = vec![];
    let base = PathBuf::from(&source.path);
    let install = base.join("share/kicad");
    let mut queue = if install.is_dir() {
        vec![install.join("footprints"), install.join("symbols")]
    } else {
        vec![base]
    };
    let mut visited = std::collections::HashSet::new();
    while let Some(path) = queue.pop() {
        if cancel() {
            break;
        }
        if visited.len() > 100000 {
            return Err(sexpr::error("Library directory limit exceeded."));
        }
        let canonical = match path.canonicalize() {
            Ok(v) => v,
            Err(e) => {
                diagnostics.push(format!("{}: {e}", path.display()));
                continue;
            }
        };
        if !visited.insert(canonical.clone()) {
            continue;
        }
        if canonical.is_dir() {
            let metadata = fs::symlink_metadata(&path)?;
            if metadata.file_type().is_symlink() {
                continue;
            }
            for entry in fs::read_dir(&canonical)? {
                queue.push(entry?.path());
            }
        } else {
            let extension = canonical.extension().and_then(|e| e.to_str()).unwrap_or("");
            if extension == "kicad_mod" || extension == "kicad_sym" {
                files.push(canonical);
            } else if canonical
                .file_name()
                .is_some_and(|n| n == "fp-lib-table" || n == "sym-lib-table")
            {
                let text = read(&canonical)?;
                match sexpr::parse(&text) {
                    Ok(root) => {
                        for lib in root.list().iter().filter(|e| e.tag() == "lib") {
                            if lib.child("disabled").is_some_and(|v| v.val(1) != "no") {
                                continue;
                            }
                            if lib.child("type").is_some_and(|t| t.val(1) != "KiCad") {
                                diagnostics.push(format!(
                                    "Unsupported library provider: {}",
                                    lib.child("name").map_or("", |n| n.val(1))
                                ));
                                continue;
                            }
                            let uri = lib.child("uri").map_or("", |u| u.val(1));
                            let mut resolved = uri.to_string();
                            for (key, value) in &source.variables {
                                resolved = resolved.replace(&format!("${{{key}}}"), value);
                            }
                            for (key, value) in std::env::vars() {
                                resolved = resolved.replace(&format!("${{{key}}}"), &value);
                            }
                            resolved = resolved.replace(
                                "${KIPRJMOD}",
                                &canonical
                                    .parent()
                                    .unwrap_or(Path::new(""))
                                    .to_string_lossy(),
                            );
                            if resolved.contains("${") {
                                diagnostics.push(format!("Unresolved library variable: {uri}"));
                                continue;
                            }
                            let dest = PathBuf::from(resolved);
                            queue.push(if dest.is_absolute() {
                                dest
                            } else {
                                canonical.parent().unwrap_or(Path::new("")).join(dest)
                            });
                        }
                    }
                    Err(e) => diagnostics.push(e.to_string()),
                }
            }
        }
        if files.len() > 100000 {
            return Err(sexpr::error("Library file count limit exceeded."));
        }
    }
    Ok((files, diagnostics))
}
pub fn validate_definition(d: &ComponentDefinition) -> ProjectResult<()> {
    if d.id.is_empty()
        || d.name.trim().is_empty()
        || d.name.len() > 500
        || d.footprint.pads.len() > 10000
    {
        return Err(sexpr::error(
            "Invalid component definition identity or size.",
        ));
    }
    for p in &d.footprint.pads {
        if ![p.x, p.y, p.width, p.height, p.rotation]
            .iter()
            .all(|v| v.is_finite())
            || p.width <= 0.
            || p.height <= 0.
        {
            return Err(sexpr::error("Invalid pad geometry."));
        }
        if !["circle", "rect", "oval", "roundrect", "custom"].contains(&p.shape.as_str()) {
            return Err(sexpr::error("Unsupported electrical pad shape."));
        }
    }
    for p in &d.footprint.pads {
        if let Some(drill) = &p.drill {
            if ![drill.x, drill.y, drill.width, drill.height]
                .iter()
                .all(|n| n.is_finite())
                || drill.width <= 0.
                || drill.height <= 0.
            {
                return Err(sexpr::error("Invalid pad drill."));
            }
        }
        for g in &p.primitives {
            validate_graphic(g)?;
        }
    }
    for g in &d.footprint.graphics {
        validate_graphic(g)?;
    }
    if let Some(s) = &d.symbol {
        if s.units.len() > 1024 {
            return Err(sexpr::error("Symbol unit limit exceeded."));
        }
        for u in &s.units {
            for p in &u.pins {
                if ![p.x, p.y, p.rotation, p.length]
                    .iter()
                    .all(|n| n.is_finite())
                    || p.length < 0.
                {
                    return Err(sexpr::error("Invalid symbol pin geometry."));
                }
            }
            for g in &u.graphics {
                validate_graphic(g)?;
            }
        }
        let pins: std::collections::HashSet<_> = s
            .units
            .iter()
            .flat_map(|u| u.pins.iter().map(|p| p.number.as_str()))
            .collect();
        let pads: std::collections::HashSet<_> =
            d.footprint.pads.iter().map(|p| p.number.as_str()).collect();
        for (pad, pin) in &d.pin_map {
            if !pads.contains(pad.as_str()) || !pins.contains(pin.as_str()) {
                return Err(sexpr::error("Pin map refers to missing pad or symbol pin."));
            }
        }
    }
    Ok(())
}
fn validate_graphic(g: &Graphic) -> ProjectResult<()> {
    if g.points.len() > 100000
        || !g.width.is_finite()
        || g.width < 0.
        || g.points
            .iter()
            .any(|p| !p.x.is_finite() || !p.y.is_finite())
    {
        return Err(sexpr::error("Invalid graphics geometry."));
    }
    Ok(())
}
pub fn validate_pcb(pcb: &crate::project::schema::VisualPcb, errors: &mut Vec<String>) {
    let nets: std::collections::HashSet<_> = pcb.nets.iter().map(|n| n.id.as_str()).collect();
    let mut ids = std::collections::HashSet::new();
    let mut refs = std::collections::HashSet::new();
    for c in &pcb.components {
        if c.id.is_empty()
            || !ids.insert(c.id.as_str())
            || c.reference.trim().is_empty()
            || !refs.insert(c.reference.to_lowercase())
            || !pcb.layers.contains(&c.layer_id)
            || ![c.x, c.y, c.rotation, c.scale]
                .iter()
                .all(|v| v.is_finite())
            || c.scale <= 0.
        {
            errors.push(
                "Invalid electrical component identity, reference, layer or transform".into(),
            );
        }
        if let Err(e) = validate_definition(&c.definition) {
            errors.push(e.to_string());
        }
        let pads: std::collections::HashSet<_> = c
            .definition
            .footprint
            .pads
            .iter()
            .filter(|p| !p.number.is_empty() && p.pad_type.as_deref() != Some("np_thru_hole"))
            .map(|p| p.number.as_str())
            .collect();
        let mut terminals = std::collections::HashSet::new();
        for t in &c.terminals {
            if !pads.contains(t.number.as_str())
                || !terminals.insert(t.number.as_str())
                || t.net_id
                    .as_ref()
                    .is_some_and(|n| !nets.contains(n.as_str()))
                || (t.nc == Some(true) && t.net_id.is_some())
            {
                errors.push("Invalid terminal or NC/net assignment".into());
            }
        }
        if terminals != pads {
            errors.push(
                "Every numbered footprint terminal requires an instance terminal record".into(),
            );
        }
    }
    if let Some(s) = &pcb.schematic {
        let mut item_ids = std::collections::HashSet::new();
        for u in &s.units {
            if !item_ids.insert(&u.id)
                || !ids.contains(u.component_id.as_str())
                || ![u.x, u.y, u.rotation].iter().all(|v| v.is_finite())
            {
                errors.push("Invalid schematic unit".into());
            }
        }
        for w in &s.wires {
            if !item_ids.insert(&w.id)
                || w.points.len() < 2
                || w.points.len() > 100000
                || w.points
                    .iter()
                    .any(|p| !p.x.is_finite() || !p.y.is_finite())
                || w.net_id
                    .as_ref()
                    .is_some_and(|n| !nets.contains(n.as_str()))
            {
                errors.push("Invalid schematic wire".into());
            }
            for a in [&w.start, &w.end].into_iter().flatten() {
                if !pcb.components.iter().any(|c| {
                    c.id == a.component_id && c.terminals.iter().any(|t| t.number == a.terminal)
                }) {
                    errors.push("Dangling schematic wire anchor".into());
                }
            }
        }
        for l in &s.labels {
            if !item_ids.insert(&l.id)
                || !l.x.is_finite()
                || !l.y.is_finite()
                || !nets.contains(l.net_id.as_str())
            {
                errors.push("Invalid schematic net label".into());
            }
        }
    }
}
#[cfg(test)]
mod real_tests {
    use super::*;
    #[test]
    fn installed_kicad_fixtures() {
        let root = Path::new("C:/Program Files/KiCad/9.0/share/kicad");
        if !root.exists() {
            return;
        }
        let f =
            read(&root.join("footprints/Resistor_SMD.pretty/R_0603_1608Metric.kicad_mod")).unwrap();
        let f = parser::footprint(&f, "fixture").unwrap();
        assert_eq!(f.pads.len(), 2);
        let d = read(&root.join("symbols/Device.kicad_sym")).unwrap();
        let s = parser::symbol(&d, "R", "fixture").unwrap();
        assert_eq!(s.units[0].pins.len(), 2);
        assert!(s.raw.len() < 10000);
        let logic = read(&root.join("symbols/74xx.kicad_sym")).unwrap();
        let gate = parser::symbol(&logic, "7400", "fixture").unwrap();
        assert_eq!(gate.units.iter().filter(|u| u.body_style == 1).count(), 5);
    }
    #[test]
    fn export_rejects_traversal_before_touching_target() {
        let p = std::env::temp_dir().join("pcbre-unsafe-export.zip");
        assert!(commands::export_files(
            &p,
            vec![commands::ExportFile {
                name: "../oops".into(),
                text: "x".into()
            }]
        )
        .is_err());
    }
    #[test]
    fn serialization_omits_legacy_component_fields() {
        let value = serde_json::json!({"id":"p","name":"PCB","layers":["a"],"images":[]});
        let pcb: crate::project::schema::VisualPcb = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(pcb).unwrap(), value);
    }
}
