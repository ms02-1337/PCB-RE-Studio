use crate::project::schema::Point;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Graphic {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rotation: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_size: Option<FontSize>,
    pub kind: String,
    pub points: Vec<Point>,
    pub width: f64,
    pub fill: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layer: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Drill {
    pub width: f64,
    pub height: f64,
    pub x: f64,
    pub y: f64,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pad {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor: Option<String>,
    #[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]
    pub pad_type: Option<String>,
    pub number: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub rotation: f64,
    pub shape: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub drill: Option<Drill>,
    pub plated: bool,
    pub layers: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub roundrect_ratio: Option<f64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub primitives: Vec<Graphic>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Footprint {
    pub id: String,
    pub name: String,
    pub source: String,
    pub raw: String,
    pub pads: Vec<Pad>,
    pub graphics: Vec<Graphic>,
    pub diagnostics: Vec<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pin {
    pub number: String,
    pub name: String,
    pub x: f64,
    pub y: f64,
    pub rotation: f64,
    pub length: f64,
    pub electrical_type: String,
    pub hidden: bool,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolUnit {
    pub unit: u32,
    pub body_style: u32,
    pub pins: Vec<Pin>,
    pub graphics: Vec<Graphic>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Symbol {
    pub id: String,
    pub name: String,
    pub source: String,
    pub raw: String,
    pub reference: String,
    pub units: Vec<SymbolUnit>,
    pub diagnostics: Vec<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentDefinition {
    pub id: String,
    pub name: String,
    pub part_name: String,
    pub value: String,
    pub reference_prefix: String,
    pub footprint: Footprint,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub symbol: Option<Symbol>,
    pub pin_map: HashMap<String, String>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Terminal {
    pub number: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub net_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nc: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ElectricalComponent {
    pub id: String,
    pub definition: ComponentDefinition,
    pub reference: String,
    pub value: String,
    pub part_name: String,
    pub x: f64,
    pub y: f64,
    pub layer_id: String,
    pub rotation: f64,
    pub scale: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locked: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub marking_id: Option<String>,
    pub terminals: Vec<Terminal>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchematicUnit {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_style: Option<u32>,
    pub id: String,
    pub component_id: String,
    pub unit: u32,
    pub x: f64,
    pub y: f64,
    pub rotation: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flip: Option<bool>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireAnchor {
    pub component_id: String,
    pub terminal: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit: Option<u32>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchematicWire {
    pub id: String,
    pub points: Vec<Point>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start: Option<WireAnchor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end: Option<WireAnchor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub net_id: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchematicLabel {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor: Option<WireAnchor>,
    pub id: String,
    pub x: f64,
    pub y: f64,
    pub net_id: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SchematicDocument {
    pub units: Vec<SchematicUnit>,
    pub wires: Vec<SchematicWire>,
    pub labels: Vec<SchematicLabel>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FontSize {
    pub width: f64,
    pub height: f64,
}
