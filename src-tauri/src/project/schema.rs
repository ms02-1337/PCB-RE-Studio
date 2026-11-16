//! `.pcbre` document schema (v1) and validation, mirrored by
//! `src/workbench/placement/projectDoc.ts`. Keep the two in sync.

use crate::project::error::{ProjectError, ProjectResult};
use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

pub const SCHEMA_VERSION: u32 = 1;
pub const PROJECT_JSON_CAP: usize = 16 * 1024 * 1024;
pub const UNASSIGNED_TYPE_ID: &str = "unassigned";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ComponentStatus {
    Unknown,
    #[default]
    Identified,
    Verified,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

/// Externally tagged variants: `{"rect":{..}} | {"ellipse":{..}} | {"polygon":{..}}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Shape {
    #[serde(rename = "rect")]
    Rect { x: f64, y: f64, w: f64, h: f64 },
    #[serde(rename = "ellipse")]
    Ellipse { cx: f64, cy: f64, rx: f64, ry: f64 },
    #[serde(rename = "polygon")]
    Polygon { points: Vec<Point> },
}

impl Shape {
    pub fn bbox(&self) -> (f64, f64, f64, f64) {
        match self {
            Shape::Rect { x, y, w, h } => (*x, *y, *w, *h),
            Shape::Ellipse { cx, cy, rx, ry } => (cx - rx, cy - ry, rx * 2.0, ry * 2.0),
            Shape::Polygon { points } => polygon_bbox(points),
        }
    }
}

fn polygon_bbox(points: &[Point]) -> (f64, f64, f64, f64) {
    let mut min_x = f64::MAX;
    let mut min_y = f64::MAX;
    let mut max_x = f64::MIN;
    let mut max_y = f64::MIN;
    for point in points {
        min_x = min_x.min(point.x);
        min_y = min_y.min(point.y);
        max_x = max_x.max(point.x);
        max_y = max_y.max(point.y);
    }
    (min_x, min_y, max_x - min_x, max_y - min_y)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentType {
    pub id: String,
    pub name: String,
    pub color: String,
    pub prefix: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CropRect {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

fn default_board_scale() -> u32 {
    100
}

/// Serializes whole-degree rotations as JSON integers (`270`, not `270.0`) so
/// legacy quarter-turn files stay byte-compatible; fractional degrees stay
/// fractional. Validation keeps values finite and inside `[0, 360)`.
fn serialize_rotation<S>(value: &f64, serializer: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    if value.fract() == 0.0 {
        serializer.serialize_i64(*value as i64)
    } else {
        serializer.serialize_f64(*value)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Board {
    pub id: String,
    pub name: String,
    pub asset_hash: String,
    /// ORIGINAL image dimensions; transforms never rewrite these.
    pub width: u32,
    pub height: u32,
    /// Image-pixel crop; absent = full image.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub crop: Option<CropRect>,
    /// Degrees clockwise; finite, `[0, 360)`, arbitrary precision (the UI
    /// writes 0.1 steps). Whole values serialize as integers.
    #[serde(default, serialize_with = "serialize_rotation")]
    pub rotation: f64,
    #[serde(default)]
    pub flip_h: bool,
    #[serde(default)]
    pub flip_v: bool,
    /// Percent; defaults to 100, always serialized.
    #[serde(default = "default_board_scale")]
    pub scale: u32,
    /// Picture lock.
    #[serde(default)]
    pub locked: bool,
    #[serde(default)]
    pub scene_x: f64,
    #[serde(default)]
    pub scene_y: f64,
}

impl Board {
    /// Plain board with default transform fields (no crop, upright, 100%).
    pub fn plain(id: &str, name: &str, asset_hash: &str, width: u32, height: u32) -> Self {
        Board {
            id: id.to_string(),
            name: name.to_string(),
            asset_hash: asset_hash.to_string(),
            width,
            height,
            crop: None,
            rotation: 0.0,
            flip_h: false,
            flip_v: false,
            scale: default_board_scale(),
            locked: false,
            scene_x: 0.0,
            scene_y: 0.0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetInfo {
    pub hash: String,
    pub size: u64,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Component {
    pub id: String,
    pub board_id: String,
    pub refdes: String,
    pub type_id: String,
    pub shape: Shape,
    #[serde(default)]
    pub status: ComponentStatus,
    #[serde(default)]
    pub locked: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub part_number: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub marking: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pkg: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manufacturer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub datasheet_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub datasheet_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_hashes: Option<Vec<String>>,
    /// Optional display names for component images, keyed by asset sha256.
    /// At most 64 entries; keys are 64-char lowercase hex; values at most
    /// 200 chars (empty string clears a name). Keys name images that are
    /// referenced through imageHashes/imageHash; they do not create blob
    /// references for garbage collection.
    #[serde(
        default,
        rename = "imageNames",
        skip_serializing_if = "Option::is_none"
    )]
    pub image_names: Option<HashMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coordinate_space: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mapping_tab_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDoc {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visual_editor: Option<VisualEditor>,
    pub schema_version: u32,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
    pub types: Vec<ComponentType>,
    pub boards: Vec<Board>,
    pub components: Vec<Component>,
    pub assets: HashMap<String, AssetInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_board_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mapping_tabs: Option<Vec<MappingTab>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_mapping_tab_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MappingTab {
    pub id: String,
    pub name: String,
    pub board_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualEditor {
    pub pcbs: Vec<VisualPcb>,
    pub active_pcb_id: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualPcb {
    pub id: String,
    pub name: String,
    pub layers: Vec<String>,
    pub images: Vec<VisualImage>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub nets: Vec<CopperNet>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub traces: Vec<CopperTrace>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub zones: Vec<CopperZone>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub vias: Vec<CopperVia>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub components: Vec<crate::kicad::types::ElectricalComponent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schematic: Option<crate::kicad::types::SchematicDocument>,
    /// World px per real mm, set by Calibrate; finite > 0; absent =
    /// uncalibrated. Additive v1 option (ADR 0003 pattern): legacy files
    /// stay byte-identical on reload+save.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub px_per_mm: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopperNet {
    pub id: String,
    pub name: String,
    pub color: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopperTrace {
    pub id: String,
    pub layer_id: String,
    pub points: Vec<Point>,
    pub width: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub net_id: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopperZone {
    pub id: String,
    pub layer_id: String,
    pub points: Vec<Point>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub net_id: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopperVia {
    pub id: String,
    pub x: f64,
    pub y: f64,
    pub diameter: f64,
    pub drill: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub net_id: Option<String>,
}
/// 2x2 linear part in canvas transform order: for ctx.transform(a, b, c, d, …)
/// a point maps x' = a·x + c·y (+ e), y' = b·x + d·y (+ f).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualWarp {
    pub a: f64,
    pub b: f64,
    pub c: f64,
    pub d: f64,
}
/// 3x3 projective map source px → straightened source px with h33 = 1
/// implicit: x' = (a·x + b·y + c) / (g·x + h·y + 1), y' = (d·x + e·y + f) /
/// (g·x + h·y + 1). Set only by Deskew; absent = identity.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualPerspective {
    pub a: f64,
    pub b: f64,
    pub c: f64,
    pub d: f64,
    pub e: f64,
    pub f: f64,
    pub g: f64,
    pub h: f64,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualImage {
    pub id: String,
    pub name: String,
    pub asset_hash: String,
    pub width: u32,
    pub height: u32,
    pub x: f64,
    pub y: f64,
    pub flip_h: bool,
    pub flip_v: bool,
    pub visible: bool,
    pub opacity: f64,
    pub locked: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layer_id: Option<String>,
    /// Image-pixel crop; absent = full image (non-destructive, like
    /// Board.crop).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub crop: Option<CropRect>,
    /// Degrees clockwise about the crop-rect center; finite `[0, 360)`;
    /// absent = 0.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rotation: Option<f64>,
    /// Per-axis display scale about the crop-rect center; finite `(0, 100]`;
    /// absent = 1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scale_x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scale_y: Option<f64>,
    /// Left-composed affine correction set by 4-point Align; absent =
    /// identity; all coefficients finite with |a·d − b·c| > 1e-9 (negative
    /// determinants mirror, which is allowed).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warp: Option<VisualWarp>,
    /// Projective deskew map (source px → straightened source px, applied
    /// innermost in the render pipeline); absent = identity. All
    /// coefficients finite with |det| > 1e-9, an invertible linear part
    /// (|a·e − b·d| > 1e-9 — the JS inverse divides by it) and no
    /// denominator pole over the photograph (w = 1 + g·x + h·y > 1e-9 at
    /// the image corners).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub perspective: Option<VisualPerspective>,
}

pub fn seed_types() -> Vec<ComponentType> {
    [
        ("resistor", "Resistor", "#e5484d", "R"),
        ("capacitor", "Capacitor", "#4f8fdb", "C"),
        ("inductor", "Inductor", "#9b6dff", "L"),
        ("diode", "Diode", "#e08a2e", "D"),
        ("transistor", "Transistor", "#2fbfa8", "Q"),
        ("ic", "IC", "#52b788", "U"),
        ("crystal", "Crystal", "#40c4e0", "Y"),
        ("connector", "Connector", "#d9a406", "J"),
        ("test-point", "Test point", "#d8d8d8", "TP"),
        (UNASSIGNED_TYPE_ID, "Unassigned", "#8a8a8a", "X"),
    ]
    .into_iter()
    .map(|(id, name, color, prefix)| ComponentType {
        id: id.to_string(),
        name: name.to_string(),
        color: color.to_string(),
        prefix: prefix.to_string(),
    })
    .collect()
}

pub fn new_doc(name: &str, now: &str) -> ProjectDoc {
    ProjectDoc {
        visual_editor: None,
        schema_version: SCHEMA_VERSION,
        name: name.to_string(),
        created_at: now.to_string(),
        updated_at: now.to_string(),
        types: seed_types(),
        boards: Vec::new(),
        components: Vec::new(),
        assets: HashMap::new(),
        active_board_id: None,
        description: None,
        mapping_tabs: Some(vec![MappingTab {
            id: "mapping-default".to_string(),
            name: "Board 1".to_string(),
            board_ids: Vec::new(),
        }]),
        active_mapping_tab_id: Some("mapping-default".to_string()),
    }
}

pub fn is_valid_hash(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_valid_color(color: &str) -> bool {
    color.len() == 7
        && color.as_bytes()[0] == b'#'
        && color[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn finite(values: &[f64]) -> bool {
    values.iter().all(|value| value.is_finite())
}

fn validate_shape(shape: &Shape, errors: &mut Vec<String>) {
    match shape {
        Shape::Rect { x, y, w, h } => {
            if !finite(&[*x, *y, *w, *h]) {
                errors.push("rect has non-finite coordinates".to_string());
            } else if *w <= 0.0 || *h <= 0.0 {
                errors.push("rect requires w > 0 and h > 0".to_string());
            }
        }
        Shape::Ellipse { cx, cy, rx, ry } => {
            if !finite(&[*cx, *cy, *rx, *ry]) {
                errors.push("ellipse has non-finite coordinates".to_string());
            } else if *rx <= 0.0 || *ry <= 0.0 {
                errors.push("ellipse requires rx > 0 and ry > 0".to_string());
            }
        }
        Shape::Polygon { points } => {
            if points.len() < 3 {
                errors.push("polygon requires at least 3 points".to_string());
            } else if points.iter().any(|p| !finite(&[p.x, p.y])) {
                errors.push("polygon has non-finite coordinates".to_string());
            } else {
                let mut seen = HashSet::with_capacity(points.len());
                for (index, point) in points.iter().enumerate() {
                    if !seen.insert((point.x.to_bits(), point.y.to_bits())) {
                        errors.push(format!("polygon point {index} is duplicated"));
                    }
                }
            }
        }
    }
}

/// Full-document validation performed before every write and after every load.
fn copper_segment_intersects(a: Point, b: Point, c: Point, d: Point) -> bool {
    let cross =
        |p: Point, q: Point, r: Point| (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    let on = |p: Point, q: Point, r: Point| {
        r.x >= p.x.min(q.x) && r.x <= p.x.max(q.x) && r.y >= p.y.min(q.y) && r.y <= p.y.max(q.y)
    };
    let (ac, ad, ca, cb) = (
        cross(a, b, c),
        cross(a, b, d),
        cross(c, d, a),
        cross(c, d, b),
    );
    (ac.signum() != ad.signum()
        && ca.signum() != cb.signum()
        && ac != 0.0
        && ad != 0.0
        && ca != 0.0
        && cb != 0.0)
        || (ac == 0.0 && on(a, b, c))
        || (ad == 0.0 && on(a, b, d))
        || (ca == 0.0 && on(c, d, a))
        || (cb == 0.0 && on(c, d, b))
}

fn valid_copper_polygon(points: &[Point]) -> bool {
    if points.len() < 3 || points.len() > 4096 || !points.iter().all(|p| finite(&[p.x, p.y])) {
        return false;
    }
    let n = points.len();
    let mut area = 0.0;
    for i in 0..n {
        let (a, b) = (points[i], points[(i + 1) % n]);
        if a == b {
            return false;
        }
        area += a.x * b.y - b.x * a.y;
        // Adjacent edges may share a vertex, but must not double back.
        let c = points[(i + 2) % n];
        let cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
        if cross == 0.0 && (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y) < 0.0 {
            return false;
        }
        for j in (i + 1)..n {
            if j == i + 1 || (i == 0 && j == n - 1) {
                continue;
            }
            if copper_segment_intersects(a, b, points[j], points[(j + 1) % n]) {
                return false;
            }
        }
    }
    area.is_finite() && area.abs() > 0.0
}

fn validate_copper(pcb: &VisualPcb, errors: &mut Vec<String>) {
    let mut ids = HashSet::new();
    let mut names = HashSet::new();
    for net in &pcb.nets {
        if net.id.trim().is_empty()
            || !ids.insert(net.id.clone())
            || net.name.trim().is_empty()
            || !names.insert(net.name.trim())
            || !is_valid_color(&net.color)
        {
            errors.push("invalid or duplicate copper net identity, name, or color".into());
        }
    }
    let net_ids = ids.clone();
    let mut check = |id: &String, net: &Option<String>, layer: Option<&String>| {
        if id.trim().is_empty() || !ids.insert(id.clone()) {
            errors.push("invalid or duplicate copper element identity".into());
        }
        if net.as_ref().is_some_and(|n| !net_ids.contains(n)) {
            errors.push("copper net is not in its PCB".into());
        }
        if layer.is_some_and(|l| !pcb.layers.contains(l)) {
            errors.push("copper layer is not in its PCB".into());
        }
    };
    for trace in &pcb.traces {
        check(&trace.id, &trace.net_id, Some(&trace.layer_id));
    }
    for zone in &pcb.zones {
        check(&zone.id, &zone.net_id, Some(&zone.layer_id));
    }
    for via in &pcb.vias {
        check(&via.id, &via.net_id, None);
    }
    for trace in &pcb.traces {
        if !trace.width.is_finite()
            || trace.width <= 0.0
            || trace.points.len() < 2
            || !trace.points.iter().all(|p| finite(&[p.x, p.y]))
            || trace.points.windows(2).any(|p| p[0] == p[1])
        {
            errors.push("invalid copper trace geometry or width".into());
        }
    }
    for zone in &pcb.zones {
        if !valid_copper_polygon(&zone.points) {
            errors.push("invalid copper zone polygon (3 to 4096 vertices required)".into());
        }
    }
    for via in &pcb.vias {
        if !finite(&[via.x, via.y, via.diameter, via.drill])
            || via.drill <= 0.0
            || via.diameter <= via.drill
        {
            errors.push("invalid copper via geometry or drill".into());
        }
    }
}

pub fn validate(doc: &ProjectDoc) -> ProjectResult<()> {
    let mut errors = Vec::new();

    if doc.schema_version != SCHEMA_VERSION {
        errors.push(format!(
            "schemaVersion must be {SCHEMA_VERSION}, found {}",
            doc.schema_version
        ));
    }
    if doc.name.trim().is_empty() {
        errors.push("project name must not be empty".to_string());
    }
    if doc.created_at.trim().is_empty() || doc.updated_at.trim().is_empty() {
        errors.push("createdAt and updatedAt must not be empty".to_string());
    }
    if let Some(description) = &doc.description {
        if description.chars().count() > 4000 {
            errors.push("description must be at most 4000 characters".to_string());
        }
    }

    if let Some(editor) = &doc.visual_editor {
        let mut pcb_ids = HashSet::new();
        let mut image_ids = HashSet::new();
        let mut all_layers = HashSet::new();
        if editor.pcbs.is_empty() {
            errors.push("visual editor needs at least one PCB".into());
        }
        for pcb in &editor.pcbs {
            if pcb.id.trim().is_empty() || !pcb_ids.insert(&pcb.id) || pcb.name.trim().is_empty() {
                errors.push("invalid or duplicate visual PCB identity".into());
            }
            if pcb.layers.is_empty() || pcb.layers.len() > 1024 {
                errors.push("visual PCB needs 1 to 1024 layers".into());
            }
            if let Some(px_per_mm) = pcb.px_per_mm {
                if !px_per_mm.is_finite() || px_per_mm <= 0.0 {
                    errors.push(format!(
                        "visual PCB {} pxPerMm must be finite and > 0, found {px_per_mm}",
                        pcb.id
                    ));
                }
            }
            for layer in &pcb.layers {
                if layer.trim().is_empty() || !all_layers.insert(layer) {
                    errors.push("invalid or duplicate visual layer identity".into());
                }
            }
            validate_copper(pcb, &mut errors);
            crate::kicad::validate_pcb(pcb, &mut errors);
            for image in &pcb.images {
                if image.id.trim().is_empty()
                    || !image_ids.insert(&image.id)
                    || image.name.trim().is_empty()
                {
                    errors.push("invalid or duplicate visual image identity".into());
                }
                if image.width == 0
                    || image.height == 0
                    || !image.x.is_finite()
                    || !image.y.is_finite()
                    || !image.opacity.is_finite()
                    || !(0.0..=1.0).contains(&image.opacity)
                {
                    errors.push("invalid visual image dimensions, position, or opacity".into());
                }
                if !is_valid_hash(&image.asset_hash) || !doc.assets.contains_key(&image.asset_hash)
                {
                    errors.push("visual image asset is missing or invalid".into());
                }
                if image
                    .layer_id
                    .as_ref()
                    .is_some_and(|id| !pcb.layers.contains(id))
                {
                    errors.push("visual image layer is not in its PCB".into());
                }
                if let Some(rotation) = image.rotation {
                    if !rotation.is_finite() || !(0.0..360.0).contains(&rotation) {
                        errors.push(format!(
                            "visual image {} rotation must be finite and within [0, 360), found {rotation}",
                            image.id
                        ));
                    }
                }
                for (field, scale) in [("scaleX", image.scale_x), ("scaleY", image.scale_y)] {
                    if let Some(scale) = scale {
                        if !scale.is_finite() || scale <= 0.0 || scale > 100.0 {
                            errors.push(format!(
                                "visual image {} {field} must be finite and within (0, 100], found {scale}",
                                image.id
                            ));
                        }
                    }
                }
                if let Some(warp) = image.warp {
                    if !finite(&[warp.a, warp.b, warp.c, warp.d]) {
                        errors.push(format!(
                            "visual image {} warp coefficients must be finite",
                            image.id
                        ));
                    } else if (warp.a * warp.d - warp.b * warp.c).abs() <= 1e-9 {
                        errors.push(format!(
                            "visual image {} warp requires |det| > 1e-9",
                            image.id
                        ));
                    }
                }
                if let Some(p) = image.perspective {
                    if !finite(&[p.a, p.b, p.c, p.d, p.e, p.f, p.g, p.h]) {
                        errors.push(format!(
                            "visual image {} perspective coefficients must be finite",
                            image.id
                        ));
                    } else {
                        let det = p.a * (p.e - p.f * p.h) - p.b * (p.d - p.f * p.g)
                            + p.c * (p.d * p.h - p.e * p.g);
                        if det.abs() <= 1e-9 {
                            errors.push(format!(
                                "visual image {} perspective requires |det| > 1e-9",
                                image.id
                            ));
                        }
                        // The JS inverse divides by the linear part's
                        // determinant; a 3x3-invertible map with that part
                        // singular would NaN every inverse. Reject it here.
                        if (p.a * p.e - p.b * p.d).abs() <= 1e-9 {
                            errors.push(format!(
                                "visual image {} perspective requires an invertible linear part",
                                image.id
                            ));
                        }
                        let corners = [
                            (0.0, 0.0),
                            (image.width as f64, 0.0),
                            (image.width as f64, image.height as f64),
                            (0.0, image.height as f64),
                        ];
                        if corners.iter().any(|(x, y)| 1.0 + p.g * x + p.h * y <= 1e-9) {
                            errors.push(format!(
                                "visual image {} perspective must have no denominator pole over the photograph",
                                image.id
                            ));
                        }
                    }
                }
                if let Some(crop) = image.crop {
                    if crop.w == 0 || crop.h == 0 {
                        errors.push(format!(
                            "visual image {} crop requires w > 0 and h > 0",
                            image.id
                        ));
                    }
                    // checked_add guards u32 overflow before comparing with
                    // the bounds (same pattern as Board.crop).
                    let right_in_bounds = crop
                        .x
                        .checked_add(crop.w)
                        .is_some_and(|right| right <= image.width);
                    let bottom_in_bounds = crop
                        .y
                        .checked_add(crop.h)
                        .is_some_and(|bottom| bottom <= image.height);
                    if !right_in_bounds || !bottom_in_bounds {
                        errors.push(format!(
                            "visual image {} crop extends beyond the image bounds",
                            image.id
                        ));
                    }
                }
            }
        }
        if !pcb_ids.contains(&editor.active_pcb_id) {
            errors.push("active visual PCB does not exist".into());
        }
    }

    let mut type_ids = HashSet::new();
    for type_ in &doc.types {
        if type_.id.trim().is_empty() {
            errors.push("component type id must not be empty".to_string());
        } else if !type_ids.insert(type_.id.clone()) {
            errors.push(format!("duplicate component type id {}", type_.id));
        }
        if type_.name.trim().is_empty() {
            errors.push(format!("component type {} has an empty name", type_.id));
        }
        if type_.prefix.trim().is_empty() {
            errors.push(format!("component type {} has an empty prefix", type_.id));
        }
        if !is_valid_color(&type_.color) {
            errors.push(format!(
                "component type {} color must be #rrggbb, found {}",
                type_.id, type_.color
            ));
        }
    }
    if !type_ids.contains(UNASSIGNED_TYPE_ID) {
        errors.push(format!(
            "the built-in {UNASSIGNED_TYPE_ID} component type is missing"
        ));
    }

    let mut board_ids = HashSet::new();
    for board in &doc.boards {
        if !board.scene_x.is_finite() || !board.scene_y.is_finite() {
            errors.push(format!("board {} scene position must be finite", board.id));
        }
        if board.id.trim().is_empty() {
            errors.push("board id must not be empty".to_string());
        } else if !board_ids.insert(board.id.clone()) {
            errors.push(format!("duplicate board id {}", board.id));
        }
        if board.name.trim().is_empty() {
            errors.push(format!("board {} has an empty name", board.id));
        }
        if !is_valid_hash(&board.asset_hash) {
            errors.push(format!(
                "board {} asset hash must be 64-char lowercase hex, found {}",
                board.id, board.asset_hash
            ));
        } else if !doc.assets.contains_key(&board.asset_hash) {
            errors.push(format!(
                "board {} references unknown asset {}",
                board.id, board.asset_hash
            ));
        }
        if board.width == 0 || board.height == 0 {
            errors.push(format!("board {} must have positive dimensions", board.id));
        }
        if !board.rotation.is_finite() || !(0.0..360.0).contains(&board.rotation) {
            errors.push(format!(
                "board {} rotation must be finite and within [0, 360), found {}",
                board.id, board.rotation
            ));
        }
        if !(10..=800).contains(&board.scale) {
            errors.push(format!(
                "board {} scale must be between 10 and 800, found {}",
                board.id, board.scale
            ));
        }
        if let Some(crop) = board.crop {
            if crop.w == 0 || crop.h == 0 {
                errors.push(format!("board {} crop requires w > 0 and h > 0", board.id));
            }
            // checked_add guards u32 overflow before comparing with the bounds.
            let right_in_bounds = crop
                .x
                .checked_add(crop.w)
                .is_some_and(|right| right <= board.width);
            let bottom_in_bounds = crop
                .y
                .checked_add(crop.h)
                .is_some_and(|bottom| bottom <= board.height);
            if !right_in_bounds || !bottom_in_bounds {
                errors.push(format!(
                    "board {} crop extends beyond the image bounds",
                    board.id
                ));
            }
        }
    }

    if let Some(tabs) = &doc.mapping_tabs {
        if tabs.is_empty() {
            errors.push("mappingTabs must contain at least one tab".to_string());
        }
        let mut tab_ids = HashSet::new();
        let mut assigned = HashSet::new();
        for tab in tabs {
            if tab.id.trim().is_empty() || !tab_ids.insert(tab.id.clone()) {
                errors.push(format!("mapping tab id {} is empty or duplicated", tab.id));
            }
            if tab.name.trim().is_empty() {
                errors.push(format!("mapping tab {} has an empty name", tab.id));
            }
            for board_id in &tab.board_ids {
                if !board_ids.contains(board_id) {
                    errors.push(format!(
                        "mapping tab {} references unknown board {board_id}",
                        tab.id
                    ));
                }
                if !assigned.insert(board_id.clone()) {
                    errors.push(format!(
                        "board {board_id} belongs to more than one mapping tab"
                    ));
                }
            }
        }
        if let Some(active) = &doc.active_mapping_tab_id {
            if !tab_ids.contains(active) {
                errors.push(format!(
                    "activeMappingTabId {active} references unknown mapping tab"
                ));
            }
        }
    } else if doc.active_mapping_tab_id.is_some() {
        errors.push("activeMappingTabId requires mappingTabs".to_string());
    }

    let mut component_ids = HashSet::new();
    let mut refdes_seen: HashMap<String, usize> = HashMap::new();
    for component in &doc.components {
        if component.id.trim().is_empty() {
            errors.push("component id must not be empty".to_string());
        } else if !component_ids.insert(component.id.clone()) {
            errors.push(format!("duplicate component id {}", component.id));
        }
        if component.refdes.trim().is_empty() {
            errors.push("refdes must not be empty".to_string());
        } else {
            *refdes_seen.entry(component.refdes.clone()).or_default() += 1;
        }
        if let Some(space) = &component.coordinate_space {
            if space != "scene" {
                errors.push(format!(
                    "component {} has unsupported coordinateSpace",
                    component.refdes
                ));
            }
        }
        if component.coordinate_space.as_deref() == Some("scene") {
            if !doc.mapping_tabs.as_ref().is_some_and(|tabs| {
                tabs.iter()
                    .any(|tab| Some(&tab.id) == component.mapping_tab_id.as_ref())
            }) {
                errors.push(format!(
                    "component {} references unknown mapping tab",
                    component.refdes
                ));
            }
        } else if !board_ids.contains(&component.board_id) {
            errors.push(format!(
                "component {} references unknown board {}",
                component.refdes, component.board_id
            ));
        }
        if !type_ids.contains(&component.type_id) {
            errors.push(format!(
                "component {} references unknown type {}",
                component.refdes, component.type_id
            ));
        }
        validate_shape(&component.shape, &mut errors);
        if component
            .description
            .as_ref()
            .is_some_and(|value| value.chars().count() > 4000)
        {
            errors.push(format!(
                "component {} description must be at most 4000 characters",
                component.refdes
            ));
        }
        for hash in component.image_hashes.iter().flatten() {
            if !is_valid_hash(hash) || !doc.assets.contains_key(hash) {
                errors.push(format!(
                    "component {} imageHashes references invalid or unknown asset {hash}",
                    component.refdes
                ));
            }
        }
        if let Some(image_names) = &component.image_names {
            if image_names.len() > 64 {
                errors.push(format!(
                    "component {} imageNames must contain at most 64 entries",
                    component.refdes
                ));
            }
            for (hash, label) in image_names {
                if !is_valid_hash(hash) {
                    errors.push(format!(
                        "component {} imageNames key must be 64-char lowercase hex, found {hash}",
                        component.refdes
                    ));
                }
                if label.chars().count() > 200 {
                    errors.push(format!(
                        "component {} imageNames values must be at most 200 characters",
                        component.refdes
                    ));
                    break;
                }
            }
        }
        for (field, hash) in [
            ("datasheetHash", component.datasheet_hash.as_deref()),
            ("imageHash", component.image_hash.as_deref()),
        ] {
            if let Some(hash) = hash {
                if !is_valid_hash(hash) {
                    errors.push(format!(
                        "component {} {} must be 64-char lowercase hex, found {}",
                        component.refdes, field, hash
                    ));
                } else if !doc.assets.contains_key(hash) {
                    errors.push(format!(
                        "component {} references unknown asset {hash}",
                        component.refdes
                    ));
                }
            }
        }
    }
    for (refdes, count) in refdes_seen {
        if count > 1 {
            errors.push(format!("refdes {refdes} is used {count} times"));
        }
    }

    for (hash, asset) in &doc.assets {
        if !is_valid_hash(hash) || hash != &asset.hash {
            errors.push(format!("asset index entry {hash} is not a valid hash"));
        }
        if asset.name.trim().is_empty() {
            errors.push(format!("asset {hash} has an empty name"));
        }
    }

    if let Some(active) = &doc.active_board_id {
        if !board_ids.contains(active) {
            errors.push(format!("activeBoardId {active} references unknown board"));
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(ProjectError::invalid_data(&errors))
    }
}

/// Hashes referenced by boards and components; entries outside this set are GC'd on save.
pub fn referenced_hashes(doc: &ProjectDoc) -> Vec<String> {
    let mut hashes = HashSet::new();
    if let Some(editor) = &doc.visual_editor {
        for pcb in &editor.pcbs {
            for image in &pcb.images {
                hashes.insert(image.asset_hash.clone());
            }
        }
    }
    for board in &doc.boards {
        hashes.insert(board.asset_hash.clone());
    }
    for component in &doc.components {
        if let Some(hash) = &component.datasheet_hash {
            hashes.insert(hash.clone());
        }
        if let Some(hash) = &component.image_hash {
            hashes.insert(hash.clone());
        }
        for hash in component.image_hashes.iter().flatten() {
            hashes.insert(hash.clone());
        }
    }
    let mut ordered: Vec<String> = hashes.into_iter().collect();
    ordered.sort();
    ordered
}

#[cfg(test)]
mod tests {
    use super::*;

    fn copper_doc() -> ProjectDoc {
        let mut value = serde_json::to_value(visual_doc()).unwrap();
        let pcb = &mut value["visualEditor"]["pcbs"][0];
        pcb["nets"] = serde_json::json!([{ "id": "net-1", "name": "GND", "color": "#aabbcc" }]);
        pcb["traces"] = serde_json::json!([{ "id": "trace-1", "layerId": "front", "netId": "net-1", "width": 2, "points": [{"x":0,"y":0},{"x":10,"y":0}] }]);
        pcb["zones"] = serde_json::json!([{ "id": "zone-1", "layerId": "back", "points": [{"x":0,"y":0},{"x":10,"y":0},{"x":0,"y":10}] }]);
        pcb["vias"] = serde_json::json!([{ "id": "via-1", "netId": "net-1", "x": 10, "y": 0, "diameter": 4, "drill": 2 }]);
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn copper_roundtrip_and_legacy_omission() {
        let doc = copper_doc();
        validate(&doc).unwrap();
        let bytes = serde_json::to_vec(&doc).unwrap();
        assert_eq!(doc, serde_json::from_slice(&bytes).unwrap());
        let legacy = serde_json::to_value(visual_doc()).unwrap();
        for field in ["nets", "traces", "zones", "vias"] {
            assert!(legacy["visualEditor"]["pcbs"][0].get(field).is_none());
        }
    }

    #[test]
    fn copper_rejects_invalid_references_and_geometry() {
        for (field, value) in [
            ("layerId", serde_json::json!("foreign")),
            ("netId", serde_json::json!("missing")),
            ("width", serde_json::json!(0)),
            ("points", serde_json::json!([{"x":0,"y":0}])),
            ("id", serde_json::json!("via-1")),
        ] {
            let mut doc = serde_json::to_value(copper_doc()).unwrap();
            doc["visualEditor"]["pcbs"][0]["traces"][0][field] = value;
            assert!(
                validate(&serde_json::from_value(doc).unwrap()).is_err(),
                "{field}"
            );
        }
        let mut doc = copper_doc();
        doc.visual_editor.as_mut().unwrap().pcbs[0].vias[0].drill = 4.0;
        assert!(validate(&doc).is_err());
        let mut doc = copper_doc();
        doc.visual_editor.as_mut().unwrap().pcbs[0].traces[0].points[0].x = f64::NAN;
        assert!(validate(&doc).is_err());
        let mut doc = copper_doc();
        doc.visual_editor.as_mut().unwrap().pcbs[0].vias[0].diameter = f64::INFINITY;
        assert!(validate(&doc).is_err());
        let mut doc = copper_doc();
        doc.visual_editor.as_mut().unwrap().pcbs[0].nets[0].color = "red".into();
        assert!(validate(&doc).is_err());
    }

    #[test]
    fn copper_rejects_self_intersecting_or_degenerate_zones() {
        for points in [
            vec![
                Point { x: 0.0, y: 0.0 },
                Point { x: 10.0, y: 10.0 },
                Point { x: 0.0, y: 10.0 },
                Point { x: 10.0, y: 0.0 },
            ],
            vec![
                Point { x: 0.0, y: 0.0 },
                Point { x: 10.0, y: 0.0 },
                Point { x: 20.0, y: 0.0 },
            ],
            vec![
                Point { x: 0.0, y: 0.0 },
                Point { x: 10.0, y: 0.0 },
                Point { x: 5.0, y: 0.0 },
                Point { x: 5.0, y: 10.0 },
            ],
        ] {
            let mut doc = copper_doc();
            doc.visual_editor.as_mut().unwrap().pcbs[0].zones[0].points = points;
            assert!(validate(&doc).is_err());
        }
    }

    fn visual_doc() -> ProjectDoc {
        let mut doc = sample_doc();
        let hash = doc.boards[0].asset_hash.clone();
        doc.visual_editor = Some(VisualEditor {
            active_pcb_id: "pcb".into(),
            pcbs: vec![VisualPcb {
                id: "pcb".into(),
                name: "PCB".into(),
                layers: vec!["front".into(), "back".into()],
                px_per_mm: Some(3.78),
                nets: vec![],
                traces: vec![],
                zones: vec![],
                vias: vec![],
                components: vec![],
                schematic: None,
                images: vec![VisualImage {
                    id: "photo".into(),
                    name: "Back photo".into(),
                    asset_hash: hash,
                    width: 100,
                    height: 200,
                    x: -12.5,
                    y: 3.0,
                    flip_h: true,
                    flip_v: false,
                    visible: true,
                    opacity: 0.5,
                    locked: true,
                    layer_id: Some("back".into()),
                    crop: Some(CropRect {
                        x: 10,
                        y: 20,
                        w: 80,
                        h: 160,
                    }),
                    rotation: Some(45.5),
                    scale_x: Some(1.25),
                    scale_y: Some(0.75),
                    warp: Some(VisualWarp {
                        a: 1.0,
                        b: 0.1,
                        c: -0.05,
                        d: 0.9,
                    }),
                    perspective: Some(VisualPerspective {
                        a: 1.02,
                        b: 0.001,
                        c: 0.5,
                        d: -0.001,
                        e: 1.01,
                        f: -0.25,
                        g: 1.0e-6,
                        h: 2.0e-6,
                    }),
                }],
            }],
        });
        doc
    }

    #[test]
    fn visual_round_trip_and_reference_retention() {
        let mut doc = visual_doc();
        doc.boards.clear();
        doc.components.clear();
        doc.active_board_id = None;
        let json = serde_json::to_string(&doc).unwrap();
        let restored: ProjectDoc = serde_json::from_str(&json).unwrap();
        assert_eq!(doc, restored);
        assert!(validate(&restored).is_ok());
        assert_eq!(referenced_hashes(&restored).len(), 1);
        let editor = doc.visual_editor.as_mut().unwrap();
        let mut duplicate = editor.pcbs[0].images[0].clone();
        duplicate.id = "duplicate".into();
        editor.pcbs[0].images.push(duplicate);
        assert_eq!(referenced_hashes(&doc).len(), 1);
    }

    #[test]
    fn invalid_visual_records_are_rejected() {
        let original = visual_doc();
        let mut bad = original.clone();
        bad.visual_editor.as_mut().unwrap().pcbs[0].images[0].opacity = 1.1;
        assert!(validate(&bad).is_err());
        let mut bad = original.clone();
        bad.visual_editor.as_mut().unwrap().pcbs[0].images[0].layer_id = Some("foreign".into());
        assert!(validate(&bad).is_err());
        let mut bad = original.clone();
        bad.visual_editor.as_mut().unwrap().active_pcb_id = "missing".into();
        assert!(validate(&bad).is_err());
        let mut bad = original.clone();
        bad.visual_editor.as_mut().unwrap().pcbs[0].images[0].width = 0;
        assert!(validate(&bad).is_err());
        let mut bad = original;
        bad.visual_editor.as_mut().unwrap().pcbs[0].images[0].asset_hash = "b".repeat(64);
        assert!(validate(&bad).is_err());
    }

    #[test]
    fn visual_transform_fields_round_trip_with_camel_case_keys() {
        let doc = visual_doc();
        let json = serde_json::to_string(&doc).unwrap();
        assert!(json.contains("\"crop\":{\"x\":10,\"y\":20,\"w\":80,\"h\":160}"));
        assert!(json.contains("\"rotation\":45.5"));
        assert!(json.contains("\"scaleX\":1.25"));
        assert!(json.contains("\"scaleY\":0.75"));
        assert!(json.contains("\"warp\":{\"a\":1.0,\"b\":0.1,\"c\":-0.05,\"d\":0.9}"));
        // ryu prints the tiny off-diagonal terms in exponent notation.
        assert!(json.contains("\"perspective\":{\"a\":1.02,\"b\":0.001,\"c\":0.5,\"d\":-0.001,\"e\":1.01,\"f\":-0.25,\"g\":1e-6,\"h\":2e-6}"));

        assert!(json.contains("\"pxPerMm\":3.78"));
        let restored: ProjectDoc = serde_json::from_str(&json).unwrap();
        assert_eq!(restored, doc);
        assert!(validate(&restored).is_ok());
    }

    #[test]
    fn legacy_visual_files_without_transform_fields_reserialize_identically() {
        // A v1 file written before the transform fields existed: the keys are
        // absent, so they deserialize to identity defaults and — thanks to
        // skip_serializing_if — a reload+save cycle is byte-identical.
        let mut value = serde_json::to_value(visual_doc()).unwrap();
        let pcb = value["visualEditor"]["pcbs"][0].as_object_mut().unwrap();
        pcb.remove("pxPerMm");
        let image = pcb["images"][0].as_object_mut().unwrap();
        for key in [
            "crop",
            "rotation",
            "scaleX",
            "scaleY",
            "warp",
            "perspective",
        ] {
            image.remove(key);
        }
        let parsed: ProjectDoc = serde_json::from_value(value).unwrap();
        let pcb = &parsed.visual_editor.as_ref().unwrap().pcbs[0];
        assert_eq!(pcb.px_per_mm, None);
        let image = &pcb.images[0];
        assert!(image.crop.is_none());
        assert!(image.rotation.is_none());
        assert!(image.scale_x.is_none());
        assert!(image.scale_y.is_none());
        assert!(image.warp.is_none());
        assert!(image.perspective.is_none());
        assert!(validate(&parsed).is_ok());
        // Reload+save keeps the file byte-identical and the fields absent.
        let saved = serde_json::to_string(&parsed).unwrap();
        for absent in ["pxPerMm", "scaleX", "scaleY", "warp", "crop", "perspective"] {
            assert!(
                !saved.contains(absent),
                "{absent} leaked into the legacy file"
            );
        }
        let reloaded: ProjectDoc = serde_json::from_str(&saved).unwrap();
        assert_eq!(reloaded, parsed);
        assert_eq!(serde_json::to_string(&reloaded).unwrap(), saved);
    }

    #[test]
    fn rejects_invalid_visual_transform_fields() {
        // Rotation: finite and inside [0, 360).
        for rotation in [f64::NAN, -0.5, 360.0, f64::INFINITY] {
            let mut doc = visual_doc();
            doc.visual_editor.as_mut().unwrap().pcbs[0].images[0].rotation = Some(rotation);
            assert!(validate(&doc)
                .unwrap_err()
                .detail
                .unwrap()
                .contains("visual image photo rotation"));
        }
        for rotation in [0.0, 359.9, 45.5] {
            let mut doc = visual_doc();
            doc.visual_editor.as_mut().unwrap().pcbs[0].images[0].rotation = Some(rotation);
            assert!(validate(&doc).is_ok());
        }

        // Per-axis scale: finite and within (0, 100]; both interval ends pass.
        for field in [0, 1] {
            let mut doc = visual_doc();
            let image = &mut doc.visual_editor.as_mut().unwrap().pcbs[0].images[0];
            if field == 0 {
                image.scale_x = Some(0.0);
            } else {
                image.scale_y = Some(101.0);
            }
            assert!(validate(&doc)
                .unwrap_err()
                .detail
                .unwrap()
                .contains("must be finite and within (0, 100]"));
        }
        for scale in [0.01, 1.0, 100.0] {
            let mut doc = visual_doc();
            let image = &mut doc.visual_editor.as_mut().unwrap().pcbs[0].images[0];
            image.scale_x = Some(scale);
            image.scale_y = Some(scale);
            assert!(validate(&doc).is_ok());
        }
        let mut doc = visual_doc();
        doc.visual_editor.as_mut().unwrap().pcbs[0].images[0].scale_x = Some(f64::NAN);
        assert!(validate(&doc)
            .unwrap_err()
            .detail
            .unwrap()
            .contains("scaleX"));

        // Warp: all-finite with |det| > 1e-9; mirroring (negative det) is fine.
        for warp in [
            VisualWarp {
                a: f64::NAN,
                b: 0.0,
                c: 0.0,
                d: 1.0,
            },
            VisualWarp {
                a: 1.0,
                b: 1.0,
                c: 1.0,
                d: 1.0,
            },
            VisualWarp {
                a: 1e-5,
                b: 0.0,
                c: 0.0,
                d: 1e-5,
            },
        ] {
            let mut doc = visual_doc();
            doc.visual_editor.as_mut().unwrap().pcbs[0].images[0].warp = Some(warp);
            let detail = validate(&doc).unwrap_err().detail.unwrap();
            assert!(detail.contains("warp"), "unexpected error: {detail}");
        }
        let mut doc = visual_doc();
        doc.visual_editor.as_mut().unwrap().pcbs[0].images[0].warp = Some(VisualWarp {
            a: -2.0,
            b: 0.0,
            c: 0.0,
            d: 1.0,
        });
        assert!(validate(&doc).is_ok());

        // Perspective: all-finite, |det| > 1e-9, and pole-free over the photo.
        let degenerate = VisualPerspective {
            a: 0.0,
            b: 0.0,
            c: 0.0,
            d: 0.0,
            e: 0.0,
            f: 0.0,
            g: 0.0,
            h: 0.0,
        };
        for perspective in [
            VisualPerspective {
                a: f64::NAN,
                b: 0.001,
                c: 0.0,
                d: 0.0,
                e: 1.0,
                f: 0.0,
                g: 0.0,
                h: 0.0,
            },
            degenerate,
            // Pole: h = −0.01 sends the denominator negative across the
            // 200px-tall fixture image (1 − 0.01·200 < 0 at the bottom).
            VisualPerspective {
                a: 1.0,
                b: 0.0,
                c: 0.0,
                d: 0.0,
                e: 1.0,
                f: 0.0,
                g: 0.0,
                h: -0.01,
            },
            // Singular linear part with full det = 1 and no pole (w = 1 + y
            // stays positive over the photo): invertible as a 3x3, but every
            // numerator collapses onto a line, so inverses would NaN.
            VisualPerspective {
                a: 1.0,
                b: 2.0,
                c: 1.0,
                d: 2.0,
                e: 4.0,
                f: 1.0,
                g: 0.0,
                h: 1.0,
            },
        ] {
            let mut doc = visual_doc();
            doc.visual_editor.as_mut().unwrap().pcbs[0].images[0].perspective = Some(perspective);
            let detail = validate(&doc).unwrap_err().detail.unwrap();
            assert!(detail.contains("perspective"), "unexpected error: {detail}");
        }
        // A mild, well-conditioned perspective passes validation.
        let mut doc = visual_doc();
        doc.visual_editor.as_mut().unwrap().pcbs[0].images[0].perspective =
            Some(VisualPerspective {
                a: 0.98,
                b: -0.002,
                c: 1.5,
                d: 0.003,
                e: 0.99,
                f: -1.0,
                g: -5.0e-7,
                h: 4.0e-7,
            });
        assert!(validate(&doc).is_ok());

        // Crop: positive size and inside the 100x200 source image.
        let mut doc = visual_doc();
        doc.visual_editor.as_mut().unwrap().pcbs[0].images[0].crop = Some(CropRect {
            x: 0,
            y: 0,
            w: 0,
            h: 100,
        });
        assert!(validate(&doc)
            .unwrap_err()
            .detail
            .unwrap()
            .contains("crop requires w > 0"));
        let mut doc = visual_doc();
        doc.visual_editor.as_mut().unwrap().pcbs[0].images[0].crop = Some(CropRect {
            x: 90,
            y: 0,
            w: 20,
            h: 100,
        });
        assert!(validate(&doc)
            .unwrap_err()
            .detail
            .unwrap()
            .contains("crop extends beyond"));
        // u32 overflow (x + w wraps past u32::MAX) must fail, not wrap.
        let mut doc = visual_doc();
        doc.visual_editor.as_mut().unwrap().pcbs[0].images[0].crop = Some(CropRect {
            x: u32::MAX,
            y: u32::MAX,
            w: u32::MAX,
            h: 10,
        });
        assert!(validate(&doc)
            .unwrap_err()
            .detail
            .unwrap()
            .contains("crop extends beyond"));
        // A full-size crop is exactly in bounds and valid.
        let mut doc = visual_doc();
        doc.visual_editor.as_mut().unwrap().pcbs[0].images[0].crop = Some(CropRect {
            x: 0,
            y: 0,
            w: 100,
            h: 200,
        });
        assert!(validate(&doc).is_ok());

        // Calibration: finite and > 0.
        for px_per_mm in [0.0, -3.78, f64::NAN, f64::INFINITY] {
            let mut doc = visual_doc();
            doc.visual_editor.as_mut().unwrap().pcbs[0].px_per_mm = Some(px_per_mm);
            assert!(validate(&doc)
                .unwrap_err()
                .detail
                .unwrap()
                .contains("pxPerMm must be finite and > 0"));
        }
        let mut doc = visual_doc();
        doc.visual_editor.as_mut().unwrap().pcbs[0].px_per_mm = Some(0.1);
        assert!(validate(&doc).is_ok());
    }

    pub fn sample_doc() -> ProjectDoc {
        let mut doc = new_doc("Fixtures", "2026-11-15T00:00:00Z");
        doc.assets.insert(
            "a".repeat(64),
            AssetInfo {
                hash: "a".repeat(64),
                size: 3,
                name: "board.png".to_string(),
            },
        );
        doc.boards
            .push(Board::plain("board-1", "Front", &"a".repeat(64), 800, 600));
        doc.active_board_id = Some("board-1".to_string());
        doc.components.push(Component {
            id: "component-1".to_string(),
            board_id: "board-1".to_string(),
            refdes: "R1".to_string(),
            type_id: "resistor".to_string(),
            shape: Shape::Rect {
                x: 10.0,
                y: 10.0,
                w: 30.0,
                h: 20.0,
            },
            status: ComponentStatus::Identified,
            locked: false,
            part_number: None,
            value: Some("10k".to_string()),
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
        doc
    }

    #[test]
    fn schema_round_trips_with_camel_case_fields() {
        let doc = sample_doc();
        let json = serde_json::to_string(&doc).unwrap();
        assert!(json.contains("\"schemaVersion\":1"));
        assert!(json.contains("\"boardId\":\"board-1\""));
        assert!(json.contains("\"assetHash\":\""));
        assert!(json.contains("\"refdes\":\"R1\""));
        assert!(!json.contains("\"datasheetUrl\""));
        let parsed: ProjectDoc = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, doc);
    }

    #[test]
    fn board_transform_fields_round_trip_with_defaults() {
        let mut doc = sample_doc();
        let board = &mut doc.boards[0];
        board.crop = Some(CropRect {
            x: 10,
            y: 20,
            w: 770,
            h: 560,
        });
        board.rotation = 270.0;
        board.flip_h = true;
        board.flip_v = false;
        board.scale = 250;
        board.locked = true;
        doc.description = Some("Front side of the rev B board".to_string());
        let json = serde_json::to_string(&doc).unwrap();
        assert!(json.contains("\"crop\":{\"x\":10,\"y\":20,\"w\":770,\"h\":560}"));
        assert!(json.contains("\"rotation\":270"));
        assert!(json.contains("\"flipH\":true"));
        assert!(json.contains("\"scale\":250"));
        assert!(json.contains("\"locked\":true"));
        assert!(json.contains("\"description\":\"Front side of the rev B board\""));
        let parsed: ProjectDoc = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, doc);
        assert!(validate(&parsed).is_ok());
    }

    #[test]
    fn rotation_serializes_whole_values_as_integers_and_fractional_as_floats() {
        let mut doc = sample_doc();
        doc.boards[0].rotation = 270.0;
        assert!(serde_json::to_string(&doc)
            .unwrap()
            .contains("\"rotation\":270"));
        let value = serde_json::to_value(&doc.boards[0]).unwrap();
        assert_eq!(value["rotation"].as_u64(), Some(270));
        doc.boards[0].rotation = 45.7;
        let value = serde_json::to_value(&doc.boards[0]).unwrap();
        assert_eq!(value["rotation"].as_f64(), Some(45.7));
        assert!(serde_json::to_string(&doc)
            .unwrap()
            .contains("\"rotation\":45.7"));
    }

    #[test]
    fn legacy_integer_rotation_files_round_trip_and_arbitrary_angles_persist() {
        // A legacy quarter-turn file stores the integer 270; it parses into
        // f64 and re-serializes byte-compatibly.
        let mut value = serde_json::to_value(sample_doc()).unwrap();
        value["boards"][0]["rotation"] = serde_json::json!(270);
        let parsed: ProjectDoc = serde_json::from_value(value).unwrap();
        assert_eq!(parsed.boards[0].rotation, 270.0);
        assert!(validate(&parsed).is_ok());
        let json = serde_json::to_string(&parsed).unwrap();
        assert!(json.contains("\"rotation\":270"));
        let restored: ProjectDoc = serde_json::from_str(&json).unwrap();
        assert_eq!(restored, parsed);

        // Arbitrary angles round-trip without drift.
        let mut doc = sample_doc();
        doc.boards[0].rotation = 45.7;
        let restored: ProjectDoc =
            serde_json::from_str(&serde_json::to_string(&doc).unwrap()).unwrap();
        assert_eq!(restored.boards[0].rotation, 45.7);
        assert_eq!(restored, doc);
        assert!(validate(&restored).is_ok());
    }

    #[test]
    fn plain_boards_always_serialize_scale_but_skip_absent_optionals() {
        let doc = sample_doc();
        let board = serde_json::to_value(&doc.boards[0]).unwrap();
        assert_eq!(board["scale"], 100);
        assert_eq!(board["rotation"], 0);
        assert_eq!(board["flipH"], false);
        assert_eq!(board["flipV"], false);
        assert_eq!(board["locked"], false);
        // Only the Option fields are skipped when absent.
        assert!(board.get("crop").is_none());
    }

    #[test]
    fn old_json_without_new_fields_loads_with_defaults() {
        // A v1 document written before transforms existed: the new board and
        // description fields are absent and must deserialize with defaults.
        let mut value = serde_json::to_value(sample_doc()).unwrap();
        for board in value["boards"].as_array_mut().unwrap() {
            let board = board.as_object_mut().unwrap();
            board.remove("crop");
            board.remove("rotation");
            board.remove("flipH");
            board.remove("flipV");
            board.remove("scale");
            board.remove("locked");
        }
        value.as_object_mut().unwrap().remove("description");
        let parsed: ProjectDoc = serde_json::from_value(value).unwrap();
        assert_eq!(parsed.description, None);
        let board = &parsed.boards[0];
        assert_eq!(board.crop, None);
        assert_eq!(board.rotation, 0.0);
        assert!(!board.flip_h && !board.flip_v && !board.locked);
        assert_eq!(board.scale, 100);
        assert!(validate(&parsed).is_ok());
    }

    #[test]
    fn rejects_description_over_4000_chars() {
        let mut doc = sample_doc();
        doc.description = Some("x".repeat(4001));
        assert!(validate(&doc)
            .unwrap_err()
            .detail
            .unwrap()
            .contains("description must be at most 4000"));
        doc.description = Some("x".repeat(4000));
        assert!(validate(&doc).is_ok());
    }

    #[test]
    fn rejects_invalid_rotation_scale_and_crop() {
        // Rotation: finite and inside [0, 360); NaN, negatives, and 360 fail.
        let mut doc = sample_doc();
        doc.boards[0].rotation = f64::NAN;
        assert!(validate(&doc)
            .unwrap_err()
            .detail
            .unwrap()
            .contains("rotation must be finite and within [0, 360)"));
        doc.boards[0].rotation = -5.0;
        assert!(validate(&doc)
            .unwrap_err()
            .detail
            .unwrap()
            .contains("rotation must be finite and within [0, 360)"));
        doc.boards[0].rotation = 360.0;
        assert!(validate(&doc)
            .unwrap_err()
            .detail
            .unwrap()
            .contains("rotation must be finite and within [0, 360)"));
        doc.boards[0].rotation = f64::INFINITY;
        assert!(validate(&doc)
            .unwrap_err()
            .detail
            .unwrap()
            .contains("rotation must be finite and within [0, 360)"));
        // Fine-grained angles are valid, including both interval ends.
        for rotation in [0.0, 45.0, 45.5, 359.9] {
            doc.boards[0].rotation = rotation;
            assert!(validate(&doc).is_ok());
        }

        let mut doc = sample_doc();
        doc.boards[0].scale = 9;
        assert!(validate(&doc)
            .unwrap_err()
            .detail
            .unwrap()
            .contains("scale"));
        doc.boards[0].scale = 801;
        assert!(validate(&doc)
            .unwrap_err()
            .detail
            .unwrap()
            .contains("scale"));
        doc.boards[0].scale = 10;
        assert!(validate(&doc).is_ok());
        doc.boards[0].scale = 800;
        assert!(validate(&doc).is_ok());

        let mut doc = sample_doc();
        doc.boards[0].crop = Some(CropRect {
            x: 0,
            y: 0,
            w: 0,
            h: 100,
        });
        assert!(validate(&doc)
            .unwrap_err()
            .detail
            .unwrap()
            .contains("crop requires w > 0"));

        let mut doc = sample_doc();
        doc.boards[0].crop = Some(CropRect {
            x: 700,
            y: 0,
            w: 200,
            h: 100,
        });
        assert!(validate(&doc)
            .unwrap_err()
            .detail
            .unwrap()
            .contains("crop extends beyond"));

        // u32 overflow (x + w wraps past u32::MAX) must fail, not wrap to pass.
        let mut doc = sample_doc();
        doc.boards[0].crop = Some(CropRect {
            x: u32::MAX,
            y: 0,
            w: u32::MAX,
            h: 100,
        });
        assert!(validate(&doc)
            .unwrap_err()
            .detail
            .unwrap()
            .contains("crop extends beyond"));

        // A full-size crop is exactly in bounds and valid.
        let mut doc = sample_doc();
        doc.boards[0].crop = Some(CropRect {
            x: 0,
            y: 0,
            w: 800,
            h: 600,
        });
        assert!(validate(&doc).is_ok());
    }

    #[test]
    fn shape_serialization_matches_frontend_variants() {
        let rect = serde_json::to_value(Shape::Rect {
            x: 1.0,
            y: 2.0,
            w: 3.0,
            h: 4.0,
        })
        .unwrap();
        assert_eq!(rect["rect"]["w"], 3.0);
        let polygon = serde_json::to_value(Shape::Polygon {
            points: vec![
                Point { x: 0.0, y: 0.0 },
                Point { x: 1.0, y: 0.0 },
                Point { x: 1.0, y: 1.0 },
            ],
        })
        .unwrap();
        assert_eq!(polygon["polygon"]["points"].as_array().unwrap().len(), 3);
        let parsed: Shape = serde_json::from_value(rect).unwrap();
        assert_eq!(
            parsed,
            Shape::Rect {
                x: 1.0,
                y: 2.0,
                w: 3.0,
                h: 4.0
            }
        );
    }

    #[test]
    fn seeds_include_undeletable_unassigned() {
        let seeds = seed_types();
        assert_eq!(seeds.len(), 10);
        assert!(seeds.iter().any(|t| t.id == UNASSIGNED_TYPE_ID));
        let unassigned = seeds.iter().find(|t| t.id == UNASSIGNED_TYPE_ID).unwrap();
        assert_eq!(unassigned.prefix, "X");
    }

    #[test]
    fn accepts_a_valid_document() {
        assert!(validate(&sample_doc()).is_ok());
    }

    #[test]
    fn mapping_tabs_and_scene_placement_round_trip_and_validate_references() {
        let mut doc = sample_doc();
        doc.mapping_tabs.as_mut().unwrap()[0].board_ids = vec!["board-1".to_string()];
        doc.boards[0].scene_x = -120.5;
        doc.boards[0].scene_y = 240.0;
        let json = serde_json::to_string(&doc).unwrap();
        assert!(json.contains("\"sceneX\":-120.5"));
        assert!(json.contains("\"mappingTabs\""));
        let parsed: ProjectDoc = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, doc);
        assert!(validate(&parsed).is_ok());
        doc.mapping_tabs.as_mut().unwrap()[0]
            .board_ids
            .push("ghost".to_string());
        assert!(validate(&doc)
            .unwrap_err()
            .detail
            .unwrap()
            .contains("unknown board ghost"));
    }

    #[test]
    fn mapping_tabs_reject_duplicate_ownership_and_non_finite_placement() {
        let mut doc = sample_doc();
        doc.mapping_tabs.as_mut().unwrap()[0].board_ids =
            vec!["board-1".to_string(), "board-1".to_string()];
        assert!(validate(&doc)
            .unwrap_err()
            .detail
            .unwrap()
            .contains("more than one mapping tab"));
        doc.mapping_tabs.as_mut().unwrap()[0].board_ids.clear();
        doc.boards[0].scene_x = f64::NAN;
        assert!(validate(&doc)
            .unwrap_err()
            .detail
            .unwrap()
            .contains("scene position must be finite"));
    }

    #[test]
    fn legacy_documents_without_scene_fields_still_load() {
        let mut value = serde_json::to_value(sample_doc()).unwrap();
        value.as_object_mut().unwrap().remove("mappingTabs");
        value.as_object_mut().unwrap().remove("activeMappingTabId");
        value["boards"][0].as_object_mut().unwrap().remove("sceneX");
        value["boards"][0].as_object_mut().unwrap().remove("sceneY");
        let parsed: ProjectDoc = serde_json::from_value(value).unwrap();
        assert!(parsed.mapping_tabs.is_none());
        assert_eq!(parsed.boards[0].scene_x, 0.0);
        assert!(validate(&parsed).is_ok());
    }

    #[test]
    fn rejects_duplicate_refdes() {
        let mut doc = sample_doc();
        let mut clone = doc.components[0].clone();
        clone.id = "component-2".to_string();
        doc.components.push(clone);
        let error = validate(&doc).unwrap_err();
        assert_eq!(error.code, "invalid_data");
        assert!(error.detail.unwrap().contains("R1"));
    }

    #[test]
    fn rejects_dangling_references() {
        let mut doc = sample_doc();
        doc.components[0].type_id = "ghost".to_string();
        doc.components[0].board_id = "ghost-board".to_string();
        let error = validate(&doc).unwrap_err();
        let detail = error.detail.unwrap();
        assert!(detail.contains("unknown type ghost"));
        assert!(detail.contains("unknown board ghost-board"));
    }

    #[test]
    fn rejects_invalid_polygons_and_hashes() {
        let mut doc = sample_doc();
        doc.components[0].shape = Shape::Polygon {
            points: vec![Point { x: 0.0, y: 0.0 }, Point { x: 1.0, y: 1.0 }],
        };
        let error = validate(&doc).unwrap_err();
        assert!(error.detail.unwrap().contains("at least 3 points"));

        let mut doc = sample_doc();
        doc.components[0].shape = Shape::Polygon {
            points: vec![
                Point { x: 0.0, y: 0.0 },
                Point { x: 5.0, y: 0.0 },
                Point { x: 0.0, y: 0.0 },
            ],
        };
        assert!(validate(&doc)
            .unwrap_err()
            .detail
            .unwrap()
            .contains("duplicated"));
    }

    #[test]
    fn rejects_bad_component_hashes() {
        let mut doc = sample_doc();
        doc.components[0].image_hash = Some("XYZ".to_string());
        let error = validate(&doc).unwrap_err();
        assert!(error.detail.unwrap().contains("lowercase hex"));

        let mut doc = sample_doc();
        doc.components[0].image_hash = Some("A".repeat(64));
        assert!(validate(&doc)
            .unwrap_err()
            .detail
            .unwrap()
            .contains("lowercase hex"));
    }

    #[test]
    fn rejects_wrong_schema_version_and_bad_shapes() {
        let mut doc = sample_doc();
        doc.schema_version = 2;
        assert!(validate(&doc)
            .unwrap_err()
            .detail
            .unwrap()
            .contains("schemaVersion must be 1"));

        let mut doc = sample_doc();
        doc.components[0].shape = Shape::Rect {
            x: 0.0,
            y: 0.0,
            w: 0.0,
            h: 5.0,
        };
        assert!(validate(&doc)
            .unwrap_err()
            .detail
            .unwrap()
            .contains("w > 0"));

        let mut doc = sample_doc();
        doc.components[0].shape = Shape::Ellipse {
            cx: 0.0,
            cy: 0.0,
            rx: -1.0,
            ry: 5.0,
        };
        assert!(validate(&doc)
            .unwrap_err()
            .detail
            .unwrap()
            .contains("rx > 0"));

        let mut doc = sample_doc();
        doc.components[0].shape = Shape::Rect {
            x: f64::NAN,
            y: 0.0,
            w: 1.0,
            h: 1.0,
        };
        assert!(validate(&doc)
            .unwrap_err()
            .detail
            .unwrap()
            .contains("non-finite"));
    }

    #[test]
    fn collects_referenced_hashes_without_duplicates() {
        let mut doc = sample_doc();
        let hash = "b".repeat(64);
        doc.assets.insert(
            hash.clone(),
            AssetInfo {
                hash: hash.clone(),
                size: 9,
                name: "r.png".to_string(),
            },
        );
        doc.components[0].image_hash = Some(hash.clone());
        let mut duplicate = doc.components[0].clone();
        duplicate.id = "component-2".to_string();
        duplicate.refdes = "R2".to_string();
        doc.components.push(duplicate);
        assert_eq!(
            referenced_hashes(&doc),
            vec!["a".repeat(64), "b".repeat(64)]
        );
    }

    #[test]
    fn scene_components_keep_valid_tab_ownership_without_an_image_and_preserve_photo_arrays() {
        let mut doc = sample_doc();
        doc.components[0].coordinate_space = Some("scene".to_string());
        doc.components[0].mapping_tab_id = Some("mapping-default".to_string());
        doc.components[0].description = Some("Measured on the board".to_string());
        let photos = vec!["b".repeat(64), "c".repeat(64)];
        for hash in &photos {
            doc.assets.insert(
                hash.clone(),
                AssetInfo {
                    hash: hash.clone(),
                    size: 5,
                    name: "photo.png".to_string(),
                },
            );
        }
        doc.components[0].image_hashes = Some(photos);
        doc.boards.clear();
        doc.active_board_id = None;
        assert!(validate(&doc).is_ok());
        assert_eq!(
            referenced_hashes(&doc),
            vec!["b".repeat(64), "c".repeat(64)]
        );
        let json = serde_json::to_string(&doc).unwrap();
        assert!(json.contains("\"coordinateSpace\":\"scene\""));
        assert!(json.contains("\"imageHashes\""));
        let restored: ProjectDoc = serde_json::from_str(&json).unwrap();
        assert_eq!(restored, doc);
        doc.components[0].mapping_tab_id = Some("missing".to_string());
        assert!(validate(&doc)
            .unwrap_err()
            .detail
            .unwrap()
            .contains("unknown mapping tab"));
    }

    #[test]
    fn scene_component_description_and_photo_references_are_validated() {
        let mut doc = sample_doc();
        doc.components[0].description = Some("x".repeat(4001));
        assert!(validate(&doc)
            .unwrap_err()
            .detail
            .unwrap()
            .contains("description must be at most 4000"));
        doc.components[0].description = Some("x".repeat(4000));
        doc.components[0].image_hashes = Some(vec!["BAD".to_string()]);
        assert!(validate(&doc)
            .unwrap_err()
            .detail
            .unwrap()
            .contains("imageHashes"));
        doc.components[0].image_hashes = Some(vec!["b".repeat(64)]);
        assert!(validate(&doc)
            .unwrap_err()
            .detail
            .unwrap()
            .contains("unknown asset"));
        doc.components[0].image_hashes = None;
        doc.components[0].coordinate_space = Some("unsupported".to_string());
        assert!(validate(&doc)
            .unwrap_err()
            .detail
            .unwrap()
            .contains("unsupported coordinateSpace"));
    }

    #[test]
    fn component_image_names_round_trip_and_validate() {
        let mut doc = sample_doc();
        doc.components[0].image_names = Some(HashMap::from([
            ("b".repeat(64), "Top view".to_string()),
            // Empty labels are allowed: the UI uses them to clear a name.
            ("c".repeat(64), String::new()),
        ]));
        let json = serde_json::to_string(&doc).unwrap();
        assert!(json.contains("\"imageNames\""));
        assert!(json.contains("\"Top view\""));
        let restored: ProjectDoc = serde_json::from_str(&json).unwrap();
        assert_eq!(restored, doc);
        assert!(validate(&restored).is_ok());
        // Absent stays absent (skip_serializing_if on the Option).
        let plain = serde_json::to_value(sample_doc()).unwrap();
        assert!(plain["components"][0].get("imageNames").is_none());
    }

    #[test]
    fn rejects_invalid_image_names() {
        let mut doc = sample_doc();
        doc.components[0].image_names = Some(HashMap::from([("b".repeat(64), "x".repeat(201))]));
        assert!(validate(&doc)
            .unwrap_err()
            .detail
            .unwrap()
            .contains("imageNames values must be at most 200"));
        doc.components[0].image_names =
            Some(HashMap::from([("BAD".to_string(), "label".to_string())]));
        assert!(validate(&doc)
            .unwrap_err()
            .detail
            .unwrap()
            .contains("imageNames key must be 64-char lowercase hex"));
        let mut names = HashMap::new();
        for index in 0..65 {
            names.insert(format!("{index:064x}"), format!("name {index}"));
        }
        doc.components[0].image_names = Some(names);
        assert!(validate(&doc)
            .unwrap_err()
            .detail
            .unwrap()
            .contains("at most 64 entries"));
        // Exactly 64 entries with valid keys and 200-char labels passes.
        let mut names = HashMap::new();
        for index in 0..64 {
            names.insert(format!("{index:064x}"), "x".repeat(200));
        }
        doc.components[0].image_names = Some(names);
        assert!(validate(&doc).is_ok());
    }
}
