//! Structured project errors surfaced to the bridge as `{code, message, detail?}`.

use serde::Serialize;

pub type ProjectResult<T> = Result<T, ProjectError>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl ProjectError {
    pub fn new(code: &str, message: &str) -> Self {
        ProjectError {
            code: code.to_string(),
            message: message.to_string(),
            detail: None,
        }
    }

    pub fn with_detail(code: &str, message: &str, detail: impl Into<String>) -> Self {
        ProjectError {
            code: code.to_string(),
            message: message.to_string(),
            detail: Some(detail.into()),
        }
    }

    pub fn invalid_path() -> Self {
        Self::new("invalid_path", "The project path must be absolute.")
    }

    pub fn no_project_open() -> Self {
        Self::new("no_project_open", "No project is currently open.")
    }

    pub fn invalid_data(details: &[String]) -> Self {
        Self::with_detail(
            "invalid_data",
            "The project document is not valid.",
            details.join("; "),
        )
    }

    pub fn unsupported_schema_version(found: u32) -> Self {
        Self::with_detail(
            "unsupported_schema_version",
            "The project was created by a newer version of PCB RE Studio.",
            format!("schemaVersion {found} is not supported; this version supports 1."),
        )
    }

    pub fn corrupt_container(reason: impl Into<String>) -> Self {
        Self::with_detail(
            "corrupt_container",
            "The project file is damaged or incomplete.",
            reason.into(),
        )
    }

    pub fn missing_blob(hash: &str) -> Self {
        Self::with_detail(
            "missing_blob",
            "A referenced project asset is missing.",
            format!("No stored blob for hash {hash}."),
        )
    }

    pub fn asset_unreadable(reason: impl Into<String>) -> Self {
        Self::with_detail(
            "asset_unreadable",
            "The asset file could not be read.",
            reason.into(),
        )
    }

    pub fn save_failed(reason: impl Into<String>) -> Self {
        Self::with_detail("save_failed", "The project could not be saved.", reason)
    }
}

impl std::fmt::Display for ProjectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.detail {
            Some(detail) => write!(f, "{} {} ({})", self.code, self.message, detail),
            None => write!(f, "{} {}", self.code, self.message),
        }
    }
}

impl std::error::Error for ProjectError {}

impl From<std::io::Error> for ProjectError {
    fn from(error: std::io::Error) -> Self {
        ProjectError::with_detail("io_error", "A file operation failed.", error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::ProjectError;

    #[test]
    fn serializes_camel_case_with_optional_detail() {
        let plain = ProjectError::new("no_project_open", "No project is currently open.");
        assert_eq!(
            serde_json::to_string(&plain).unwrap(),
            r#"{"code":"no_project_open","message":"No project is currently open."}"#
        );
        let detailed = ProjectError::invalid_data(&["Duplicate refdes R1".to_string()]);
        let json = serde_json::to_value(detailed).unwrap();
        assert_eq!(json["code"], "invalid_data");
        assert_eq!(json["detail"], "Duplicate refdes R1");
    }
}
