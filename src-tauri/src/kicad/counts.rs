use super::sexpr::{self, Expr};
use crate::project::error::ProjectResult;
use std::collections::{HashMap, HashSet};

/// Read metadata once per indexed file; never load full geometry per search row.
pub fn counts(raw: &str) -> ProjectResult<HashMap<String, Option<usize>>> {
    let root = sexpr::parse(raw)?;
    if root.tag() == "footprint" || root.tag() == "module" {
        let numbers: HashSet<_> = root
            .list()
            .iter()
            .filter(|p| p.tag() == "pad" && p.val(2) != "np_thru_hole" && !p.val(1).is_empty())
            .map(|p| p.val(1))
            .collect();
        return Ok(HashMap::from([(String::new(), Some(numbers.len()))]));
    }
    let entries: HashMap<_, _> = root
        .list()
        .iter()
        .filter(|e| e.tag() == "symbol")
        .map(|e| (e.val(1), e))
        .collect();
    fn resolve(
        name: &str,
        entries: &HashMap<&str, &Expr>,
        seen: &mut HashSet<String>,
        memo: &mut HashMap<String, Option<HashSet<String>>>,
    ) -> Option<HashSet<String>> {
        if let Some(value) = memo.get(name) {
            return value.clone();
        }
        if seen.len() >= 128 || !seen.insert(name.into()) {
            return None;
        }
        let result = (|| {
            let entry = entries.get(name)?;
            let mut numbers = if let Some(parent) = entry.child("extends") {
                resolve(parent.val(1), entries, seen, memo)?
            } else {
                HashSet::new()
            };
            for unit in entry.list().iter().filter(|e| e.tag() == "symbol") {
                for pin in unit.list().iter().filter(|e| e.tag() == "pin") {
                    let n = pin.child("number").map_or("", |e| e.val(1));
                    if !n.is_empty() {
                        numbers.insert(n.into());
                    }
                }
            }
            Some(numbers)
        })();
        seen.remove(name);
        memo.insert(name.into(), result.clone());
        result
    }
    let mut memo = HashMap::new();
    Ok(entries
        .keys()
        .map(|name| {
            (
                name.to_string(),
                resolve(name, &entries, &mut HashSet::new(), &mut memo).map(|v| v.len()),
            )
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn counts_unique_electrical_pads() {
        let result = counts(r#"(footprint "F" (pad "1" smd rect) (pad "1" thru_hole circle) (pad "2" smd rect) (pad "3" np_thru_hole circle) (pad "" smd rect))"#).unwrap();
        assert_eq!(result[""], Some(2));
    }
    #[test]
    fn counts_inherited_pins_across_units_and_styles() {
        let result = counts(r#"(kicad_symbol_lib (symbol "base" (symbol "base_1_1" (pin passive line (number "1"))) (symbol "base_1_2" (pin passive line (number "1"))) (symbol "base_2_1" (pin passive line (number "2")))) (symbol "child" (extends "base")) (symbol "empty") (symbol "bad" (extends "missing")) (symbol "cycle" (extends "cycle")))"#).unwrap();
        assert_eq!(result["base"], Some(2));
        assert_eq!(result["child"], Some(2));
        assert_eq!(result["empty"], Some(0));
        assert_eq!(result["bad"], None);
        assert_eq!(result["cycle"], None);
    }
}
