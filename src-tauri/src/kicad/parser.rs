use super::{
    sexpr::{self, Expr},
    types::*,
};
use crate::project::{error::ProjectResult, schema::Point};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
pub fn hash(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}
fn xy(e: Option<&Expr>) -> Point {
    Point {
        x: e.map_or(0., |e| e.num(1)),
        y: e.map_or(0., |e| e.num(2)),
    }
}
fn graphic(e: &Expr) -> Option<Graphic> {
    let tag = e.tag().trim_start_matches("fp_").trim_start_matches("gr_");
    let kind = match tag {
        "line" => "line",
        "rect" | "rectangle" => "rect",
        "circle" => "circle",
        "arc" => "arc",
        "poly" | "polygon" | "polyline" => "polyline",
        "curve" | "bezier" => "bezier",
        "text" => "text",
        _ => return None,
    };
    let mut points = vec![];
    for key in if kind == "arc" {
        vec!["start", "mid", "end"]
    } else if kind == "circle" {
        vec!["center", "end"]
    } else {
        vec!["start", "end"]
    } {
        if let Some(c) = e.child(key) {
            points.push(xy(Some(c)));
        }
    }
    if let Some(pts) = e.child("pts") {
        points = pts
            .list()
            .iter()
            .filter(|p| p.tag() == "xy")
            .map(|p| xy(Some(p)))
            .collect();
    }
    if kind == "text" {
        points.push(xy(e.child("at")));
    }
    Some(Graphic {
        rotation: if kind == "text" {
            Some(e.child("at").map_or(0., |a| a.num(3)))
        } else {
            None
        },
        font_size: e
            .child("effects")
            .and_then(|e| e.child("font"))
            .and_then(|f| f.child("size"))
            .map(|s| FontSize {
                width: s.num(1),
                height: s.num(2),
            }),
        kind: kind.into(),
        points,
        width: e.child("width").map_or_else(
            || {
                e.child("stroke")
                    .and_then(|s| s.child("width"))
                    .map_or(0.15, |w| w.num(1))
            },
            |w| w.num(1),
        ),
        fill: e.child("fill").is_some_and(|f| {
            f.val(1) == "yes" || f.child("type").is_some_and(|t| t.val(1) != "none")
        }),
        text: if kind == "text" {
            Some(e.val(if e.tag() == "fp_text" { 2 } else { 1 }).into())
        } else {
            None
        },
        layer: e.child("layer").map(|l| l.val(1).into()),
    })
}
fn checked_numbers(e: &Expr) -> ProjectResult<()> {
    for child in e.list() {
        if let Expr::List(_) = child {
            checked_numbers(child)?;
        }
    }
    if matches!(
        e.tag(),
        "at" | "start"
            | "end"
            | "mid"
            | "center"
            | "size"
            | "xy"
            | "width"
            | "length"
            | "roundrect_rratio"
    ) {
        for a in e.list().iter().skip(1) {
            if matches!(a, Expr::List(_)) {
                continue;
            }
            let text = a.atom();
            if e.tag() == "at" && matches!(text, "unlocked" | "hide") {
                continue;
            }
            let number = text
                .parse::<f64>()
                .map_err(|_| sexpr::error("Malformed library coordinate."))?;
            if !number.is_finite() || number.abs() > 1e9 {
                return Err(sexpr::error("Non-finite or excessive library coordinate."));
            }
        }
    }
    Ok(())
}
fn version(root: &Expr) -> ProjectResult<()> {
    if root.child("version").is_some_and(|v| v.num(1) > 20241229.) {
        return Err(sexpr::error(
            "Library format is newer than the supported KiCad 9 version.",
        ));
    }
    Ok(())
}
pub fn footprint(raw: &str, source: &str) -> ProjectResult<Footprint> {
    let root = sexpr::parse(raw)?;
    version(&root)?;
    if root.tag() != "footprint" {
        return Err(sexpr::error("Expected modern .kicad_mod footprint."));
    }
    checked_numbers(&root)?;
    let mut pads = vec![];
    let mut graphics = vec![];
    for e in root.list() {
        if e.tag() == "pad" {
            let at = e.child("at");
            let size = e.child("size");
            let shape = e.val(3);
            if !["rect", "circle", "oval", "roundrect", "trapezoid", "custom"].contains(&shape) {
                return Err(sexpr::error("Unsupported electrical pad shape."));
            }
            let drill = e.child("drill").map(|d| {
                let oval = d.val(1) == "oval";
                let w = d.num(if oval { 2 } else { 1 });
                let h = if oval { d.num(3) } else { w };
                let offset = xy(d.child("offset"));
                Drill {
                    width: w,
                    height: h,
                    x: offset.x,
                    y: offset.y,
                }
            });
            let mut primitives = vec![];
            if let Some(p) = e.child("primitives") {
                for c in p.list().iter().skip(1) {
                    let primitive = graphic(c)
                        .ok_or_else(|| sexpr::error("Unsupported custom pad primitive."))?;
                    super::validate_pad_primitive(&primitive)?;
                    primitives.push(primitive);
                }
            }
            if shape == "trapezoid" {
                return Err(sexpr::error(
                    "Trapezoid pads require explicit geometry support; entry is not usable.",
                ));
            }
            let pad = Pad {
                anchor: e
                    .child("options")
                    .and_then(|o| o.child("anchor"))
                    .map(|a| a.val(1).into()),
                pad_type: Some(e.val(2).into()),
                number: e.val(1).into(),
                x: at.map_or(0., |a| a.num(1)),
                y: at.map_or(0., |a| a.num(2)),
                rotation: at.map_or(0., |a| a.num(3)),
                width: size.map_or(0., |s| s.num(1)),
                height: size.map_or(0., |s| s.num(2)),
                shape: shape.into(),
                drill,
                plated: e.val(2) == "thru_hole",
                layers: e.child("layers").map_or_else(Vec::new, |l| {
                    l.list().iter().skip(1).map(|v| v.atom().into()).collect()
                }),
                roundrect_ratio: e.child("roundrect_rratio").map(|r| r.num(1)),
                primitives,
            };
            if pad.width <= 0. || pad.height <= 0. {
                return Err(sexpr::error("Invalid pad dimensions."));
            }
            pads.push(pad);
        } else if let Some(g) = graphic(e) {
            graphics.push(g);
        }
    }
    if pads.len() > 10000 {
        return Err(sexpr::error("Footprint exceeds pad limit."));
    }
    Ok(Footprint {
        id: hash(raw),
        name: root.val(1).into(),
        source: source.into(),
        raw: raw.into(),
        pads,
        graphics,
        diagnostics: vec![],
    })
}
pub fn symbol_names(raw: &str) -> ProjectResult<Vec<String>> {
    let root = sexpr::parse(raw)?;
    version(&root)?;
    if root.tag() != "kicad_symbol_lib" {
        return Err(sexpr::error("Expected modern .kicad_sym library."));
    }
    Ok(root
        .list()
        .iter()
        .filter(|e| e.tag() == "symbol")
        .map(|e| e.val(1).into())
        .collect())
}
pub fn symbol(raw: &str, name: &str, source: &str) -> ProjectResult<Symbol> {
    let root = sexpr::parse(raw)?;
    version(&root)?;
    if root.tag() != "kicad_symbol_lib" {
        return Err(sexpr::error("Expected modern symbol library."));
    }
    checked_numbers(&root)?;
    let entries: HashMap<&str, &Expr> = root
        .list()
        .iter()
        .filter(|e| e.tag() == "symbol")
        .map(|e| (e.val(1), e))
        .collect();
    let mut stack = HashSet::new();
    fn inherit<'a>(
        name: &str,
        entries: &HashMap<&'a str, &'a Expr>,
        stack: &mut HashSet<String>,
    ) -> ProjectResult<Vec<&'a Expr>> {
        if stack.len() >= 128 {
            return Err(sexpr::error("Symbol inheritance depth limit exceeded."));
        }
        if !stack.insert(name.into()) {
            return Err(sexpr::error("Cyclic symbol inheritance."));
        }
        let current = entries
            .get(name)
            .ok_or_else(|| sexpr::error("Missing inherited symbol."))?;
        let mut result = if let Some(parent) = current.child("extends") {
            inherit(parent.val(1), entries, stack)?
        } else {
            vec![]
        };
        result.push(*current);
        Ok(result)
    }
    let chain = inherit(name, &entries, &mut stack)?;
    let mut reference = "U".to_string();
    let mut groups: HashMap<(u32, u32), SymbolUnit> = HashMap::new();
    for item in &chain {
        for c in item.list() {
            if c.tag() == "property" && c.val(1) == "Reference" {
                reference = c.val(2).into();
            }
            if c.tag() != "symbol" {
                continue;
            }
            let parts: Vec<_> = c.val(1).rsplitn(3, '_').collect();
            let unit = parts.get(1).and_then(|n| n.parse().ok()).unwrap_or(1);
            let style = parts.first().and_then(|n| n.parse().ok()).unwrap_or(1);
            let group = groups.entry((unit, style)).or_insert(SymbolUnit {
                unit,
                body_style: style,
                pins: vec![],
                graphics: vec![],
            });
            for g in c.list().iter().skip(2) {
                if g.tag() == "pin" {
                    let at = g.child("at");
                    group.pins.push(Pin {
                        number: g.child("number").map_or("", |n| n.val(1)).into(),
                        name: g.child("name").map_or("", |n| n.val(1)).into(),
                        x: at.map_or(0., |a| a.num(1)),
                        y: at.map_or(0., |a| a.num(2)),
                        rotation: at.map_or(0., |a| a.num(3)),
                        length: g.child("length").map_or(2.54, |l| l.num(1)),
                        electrical_type: g.val(1).into(),
                        hidden: g.list().iter().any(|a| a.atom() == "hide")
                            || g.child("hide").is_some_and(|h| h.val(1) != "no"),
                    });
                } else if let Some(graphic) = graphic(g) {
                    group.graphics.push(graphic);
                }
            }
        }
    }
    let commons: Vec<_> = groups
        .values()
        .filter(|u| u.unit == 0 || u.body_style == 0)
        .cloned()
        .collect();
    let max = groups.keys().map(|(u, _)| *u).max().unwrap_or(1).max(1);
    if max > 1024 {
        return Err(sexpr::error("Symbol unit limit exceeded."));
    }
    for unit in 1..=max {
        for style in 1..=2 {
            let common: Vec<_> = commons
                .iter()
                .filter(|c| {
                    (c.unit == 0 || c.unit == unit) && (c.body_style == 0 || c.body_style == style)
                })
                .collect();
            if groups.contains_key(&(unit, style)) || style == 1 {
                let g = groups.entry((unit, style)).or_insert(SymbolUnit {
                    unit,
                    body_style: style,
                    pins: vec![],
                    graphics: vec![],
                });
                for c in common {
                    g.pins.extend(c.pins.clone());
                    g.graphics.extend(c.graphics.clone());
                }
            }
        }
    }
    let mut units: Vec<_> = groups
        .into_values()
        .filter(|u| u.unit > 0 && u.body_style > 0)
        .collect();
    units.sort_by_key(|u| (u.unit, u.body_style));
    let mut children = vec![Expr::Atom("symbol".into()), Expr::Text(name.into())];
    for item in chain {
        children.extend(
            item.list()
                .iter()
                .skip(2)
                .filter(|e| e.tag() != "extends")
                .cloned(),
        );
    }
    let normalized = format!(
        "(kicad_symbol_lib (version 20241209) (generator pcbre_studio) {})",
        sexpr::print(&Expr::List(children))
    );
    Ok(Symbol {
        id: hash(&normalized),
        name: name.into(),
        source: source.into(),
        raw: normalized,
        reference,
        units,
        diagnostics: vec![],
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn footprint_rotated_drill() {
        let f=footprint(r#"(footprint "test" (pad "1" thru_hole oval (at 1 2 37) (size 2 3) (drill oval 0.6 1.2 (offset 0.1 0.2)) (layers "*.Cu" "*.Mask")))"#,"test").unwrap();
        assert_eq!(f.pads[0].rotation, 37.);
        assert_eq!(f.pads[0].drill.as_ref().unwrap().height, 1.2);
    }
    #[test]
    fn inherited_multiunit() {
        let s=symbol(r#"(kicad_symbol_lib (symbol "base" (property "Reference" "U") (symbol "base_1_1" (pin input line (at 0 0 0) (length 2) (name "A") (number "1"))) (symbol "base_2_1" (pin output line (at 5 0 180) (number "2")))) (symbol "child" (extends "base")))"#,"child","test").unwrap();
        assert_eq!(s.units.len(), 2);
        assert_eq!(s.units[1].pins[0].number, "2");
    }
    #[test]
    fn rejects_cycle_and_deep() {
        assert!(symbol(r#"(kicad_symbol_lib (symbol "a" (extends "a")))"#, "a", "").is_err());
        assert!(sexpr::parse(&"(".repeat(140)).is_err());
    }
}

#[cfg(test)]
mod serializer_tests {
    use super::*;
    #[test]
    fn flattened_symbol_preserves_token_kinds() {
        let raw = r#"(kicad_symbol_lib (symbol "base" (symbol "base_1_1" (pin passive line (at 0 0 180) (length 2.54) (name "V +") (number "01")))) (symbol "child" (extends "base")))"#;
        let first = symbol(raw, "child", "test").unwrap();
        let second = symbol(&first.raw, "child", "test").unwrap();
        assert_eq!(first.units, second.units);
        assert!(first.raw.contains("(pin passive line"));
        assert!(first.raw.contains("\"01\""));
    }
}
#[cfg(test)]
mod strict_tests {
    use super::*;
    #[test]
    fn malformed_numbers_and_unit_bombs_reject() {
        assert!(footprint(
            r#"(footprint "bad" (pad "1" smd rect (at wrong 1) (size 1 1) (layers "F.Cu")))"#,
            "x"
        )
        .is_err());
        assert!(symbol(
            r#"(kicad_symbol_lib (symbol "bad" (symbol "bad_999999999_1")))"#,
            "bad",
            "x"
        )
        .is_err());
    }
    #[test]
    fn unsupported_electrical_geometry_is_explicit() {
        assert!(footprint(
            r#"(footprint "bad" (pad "1" smd trapezoid (size 1 1) (layers "F.Cu")))"#,
            "x"
        )
        .is_err());
        assert!(footprint(r#"(footprint "bad" (pad "1" smd custom (size 1 1) (layers "F.Cu") (primitives (gr_arc (start 0 0) (mid 1 1) (end 2 0) (width 0.2)))))"#,"x").is_err());
    }
    #[test]
    fn custom_anchor_preserved() {
        let f=footprint(r#"(footprint "custom" (pad "1" smd custom (at 1 2 37) (size 1 1) (layers "F.Cu") (options (anchor circle)) (primitives (gr_poly (pts (xy 0 0) (xy 1 0) (xy 0 1)) (width 0) (fill yes)))))"#,"x").unwrap();
        assert_eq!(f.pads[0].anchor.as_deref(), Some("circle"));
        assert_eq!(f.pads[0].primitives[0].points.len(), 3);
    }
}
