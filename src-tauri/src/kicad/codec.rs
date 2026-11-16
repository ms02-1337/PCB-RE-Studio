//! Container-only definition interning. IPC documents remain fully hydrated.
use super::parser::hash;
use crate::project::{
    error::{ProjectError, ProjectResult},
    schema::ProjectDoc,
};
use serde_json::{Map, Value};
pub fn encode(doc: &ProjectDoc) -> ProjectResult<String> {
    let mut value =
        serde_json::to_value(doc).map_err(|e| ProjectError::save_failed(e.to_string()))?;
    let mut definitions = Map::new();
    if let Some(pcbs) = value
        .pointer_mut("/visualEditor/pcbs")
        .and_then(Value::as_array_mut)
    {
        for pcb in pcbs {
            if let Some(components) = pcb.get_mut("components").and_then(Value::as_array_mut) {
                for c in components {
                    if let Some(object) = c.as_object_mut() {
                        if let Some(mut definition) = object.remove("definition") {
                            for key in ["footprint", "symbol"] {
                                if let Some(source) =
                                    definition.get_mut(key).and_then(|d| d.get_mut("source"))
                                {
                                    if let Some(path) = source.as_str() {
                                        *source = Value::String(
                                            path.rsplit(['\\', '/']).next().unwrap_or(path).into(),
                                        );
                                    }
                                }
                            }
                            let text = serde_json::to_string(&definition)
                                .map_err(|e| ProjectError::save_failed(e.to_string()))?;
                            let id = hash(&text);
                            definitions.insert(id.clone(), definition);
                            object.insert("definitionRef".into(), Value::String(id));
                        }
                    }
                }
            }
        }
    }
    if definitions.is_empty() {
        return serde_json::to_string(doc).map_err(|e| ProjectError::save_failed(e.to_string()));
    }
    if !definitions.is_empty() {
        value
            .as_object_mut()
            .unwrap()
            .insert("componentDefinitions".into(), Value::Object(definitions));
    }
    serde_json::to_string(&value).map_err(|e| ProjectError::save_failed(e.to_string()))
}
pub fn decode(json: &[u8]) -> ProjectResult<ProjectDoc> {
    let mut value: Value =
        serde_json::from_slice(json).map_err(|e| ProjectError::corrupt_container(e.to_string()))?;
    let definitions = value
        .as_object_mut()
        .and_then(|o| o.remove("componentDefinitions"))
        .unwrap_or(Value::Object(Map::new()));
    let definitions = definitions
        .as_object()
        .ok_or_else(|| ProjectError::corrupt_container("Invalid component definitions table."))?;
    let mut sizes = Map::new();
    for (id, definition) in definitions {
        let text = serde_json::to_string(definition)
            .map_err(|e| ProjectError::corrupt_container(e.to_string()))?;
        if hash(&text) != *id {
            return Err(ProjectError::corrupt_container(
                "Component definition hash mismatch.",
            ));
        }
        sizes.insert(id.clone(), Value::from(text.len()));
    }
    let mut expanded = json.len();
    if let Some(pcbs) = value
        .pointer_mut("/visualEditor/pcbs")
        .and_then(Value::as_array_mut)
    {
        for pcb in pcbs {
            if let Some(components) = pcb.get_mut("components").and_then(Value::as_array_mut) {
                for c in components {
                    if let Some(object) = c.as_object_mut() {
                        if let Some(id) = object.remove("definitionRef") {
                            let id = id.as_str().ok_or_else(|| {
                                ProjectError::corrupt_container("Invalid definition reference.")
                            })?;
                            if object.contains_key("definition") {
                                return Err(ProjectError::corrupt_container(
                                    "Ambiguous component definition.",
                                ));
                            }
                            let definition = definitions.get(id).ok_or_else(|| {
                                ProjectError::corrupt_container("Missing component definition.")
                            })?;
                            expanded += sizes[id].as_u64().unwrap_or(0) as usize;
                            if expanded > 128 * 1024 * 1024 {
                                return Err(ProjectError::corrupt_container(
                                    "Expanded component snapshots exceed 128 MiB.",
                                ));
                            }
                            object.insert("definition".into(), definition.clone());
                        }
                    }
                }
            }
        }
    }
    serde_json::from_value(value).map_err(|e| ProjectError::corrupt_container(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn document() -> ProjectDoc {
        let mut value = serde_json::to_value(crate::project::schema::new_doc(
            "test",
            "2026-01-01T00:00:00Z",
        ))
        .unwrap();
        let definition = json!({"id":"d","name":"Resistor","partName":"R","value":"10k","referencePrefix":"R","footprint":{"id":"f","name":"R","source":"R","raw":"(footprint R)","pads":[{"number":"1","x":0,"y":0,"width":1,"height":1,"rotation":0,"shape":"rect","plated":false,"layers":["F.Cu"]}],"graphics":[],"diagnostics":[]},"pinMap":{}});
        let component = |id: &str, reference: &str| json!({"id":id,"reference":reference,"definition":definition,"value":"10k","partName":"R","x":0,"y":0,"layerId":"front","rotation":0,"scale":1,"terminals":[{"number":"1"}]});
        value["visualEditor"] = json!({"activePcbId":"p","pcbs":[{"id":"p","name":"PCB","layers":["front"],"images":[],"components":[component("c1","R1"),component("c2","R2")]}]});
        serde_json::from_value(value).unwrap()
    }
    #[test]
    fn definitions_intern_and_hydrate_without_runtime_changes() {
        let doc = document();
        crate::project::schema::validate(&doc).unwrap();
        let encoded = encode(&doc).unwrap();
        let value: Value = serde_json::from_str(&encoded).unwrap();
        assert_eq!(value["componentDefinitions"].as_object().unwrap().len(), 1);
        assert!(value["visualEditor"]["pcbs"][0]["components"][0]
            .get("definition")
            .is_none());
        assert_eq!(decode(encoded.as_bytes()).unwrap(), doc);
    }
    #[test]
    fn missing_and_tampered_snapshots_reject() {
        let mut value: Value = serde_json::from_str(&encode(&document()).unwrap()).unwrap();
        let key = value["componentDefinitions"]
            .as_object()
            .unwrap()
            .keys()
            .next()
            .unwrap()
            .clone();
        value["componentDefinitions"][&key]["name"] = json!("tampered");
        assert!(decode(serde_json::to_string(&value).unwrap().as_bytes()).is_err());
        value["componentDefinitions"] = json!({});
        assert!(decode(serde_json::to_string(&value).unwrap().as_bytes()).is_err());
    }
    #[test]
    fn invalid_nc_and_dangling_anchor_reject() {
        let mut doc = document();
        let c = &mut doc.visual_editor.as_mut().unwrap().pcbs[0].components[0];
        c.terminals[0].net_id = Some("missing".into());
        c.terminals[0].nc = Some(true);
        assert!(crate::project::schema::validate(&doc).is_err());
    }
    #[test]
    fn legacy_encode_unchanged() {
        let doc = crate::project::schema::new_doc("old", "2026-01-01T00:00:00Z");
        assert_eq!(encode(&doc).unwrap(), serde_json::to_string(&doc).unwrap());
    }
}
