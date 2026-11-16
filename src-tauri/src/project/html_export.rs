//! Standalone HTML export writer: replaces `@@ASSET:<hash>.<ext>@@` tokens
//! with base64 `data:` URIs, sourcing blobs from staging first and then the
//! open container (the same policy as `asset_read`). The token grammar is
//! strict - any literal `@@ASSET:` text that does not parse exactly is an
//! `invalid_data` error, never silently passed through.

use crate::project::assets::read_from_container;
use crate::project::error::{ProjectError, ProjectResult};
use base64::Engine as _;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const TOKEN_PREFIX: &str = "@@ASSET:";
const TOKEN_SUFFIX: &str = "@@";
const HASH_LEN: usize = 64;
const MAX_EXT_LEN: usize = 5;

/// One parsed token occurrence: its byte range in the HTML plus the blob it
/// references.
struct Token {
    start: usize,
    end: usize,
    hash: String,
    ext: String,
}

fn mime_for(ext: &str) -> Option<&'static str> {
    match ext {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        _ => None,
    }
}

fn is_lower_hex(byte: u8) -> bool {
    byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
}

fn invalid_token(at: usize) -> ProjectError {
    ProjectError::invalid_data(&[format!(
        "the HTML contains an invalid {TOKEN_PREFIX} token near byte {at}"
    )])
}

/// Scans `html` for `@@ASSET:<64 lowercase hex>.<ext>@@` tokens. Every literal
/// `@@ASSET:` occurrence must match the full grammar with a known image
/// extension; otherwise the export fails with `invalid_data`.
fn scan_tokens(html: &str) -> ProjectResult<Vec<Token>> {
    let bytes = html.as_bytes();
    let mut tokens = Vec::new();
    let mut cursor = 0usize;
    while let Some(found) = html[cursor..].find(TOKEN_PREFIX) {
        let start = cursor + found;
        let hash_start = start + TOKEN_PREFIX.len();
        let dot_index = hash_start + HASH_LEN;
        let ext_start = dot_index + 1;
        // Prefix + hash + dot + at least one ext char + "@@".
        if bytes.len() < ext_start + 1 + TOKEN_SUFFIX.len() {
            return Err(invalid_token(start));
        }
        if !bytes[hash_start..hash_start + HASH_LEN]
            .iter()
            .all(|&byte| is_lower_hex(byte))
        {
            return Err(invalid_token(start));
        }
        if bytes[dot_index] != b'.' {
            return Err(invalid_token(start));
        }
        let mut end = ext_start;
        while end < bytes.len()
            && bytes[end].is_ascii_alphanumeric()
            && end - ext_start < MAX_EXT_LEN
        {
            end += 1;
        }
        let ext = &html[ext_start..end];
        if ext.is_empty() || !html[end..].starts_with(TOKEN_SUFFIX) {
            return Err(invalid_token(start));
        }
        let end = end + TOKEN_SUFFIX.len();
        tokens.push(Token {
            start,
            end,
            hash: html[hash_start..hash_start + HASH_LEN].to_string(),
            ext: ext.to_string(),
        });
        cursor = end;
    }
    Ok(tokens)
}

/// Blob bytes for one hash: staging first, then the open container zip.
fn blob_bytes(hash: &str, staging_root: &Path, open_zip: Option<&Path>) -> ProjectResult<Vec<u8>> {
    if let Ok(bytes) = fs::read(staging_root.join(hash)) {
        return Ok(bytes);
    }
    if let Some(zip) = open_zip {
        if let Some(bytes) = read_from_container(zip, hash) {
            return Ok(bytes);
        }
    }
    Err(ProjectError::missing_blob(hash))
}

/// `<target name>.<8 lowercase hex>.tmp` next to the destination, avoiding
/// collisions with existing files (mirrors `container::unique_temp_path`).
fn unique_temp_path(target: &Path, directory: &Path) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    for attempt in 0..64u128 {
        let suffix = format!("{:016x}", nanos.wrapping_add(attempt.wrapping_mul(0x9e37)));
        let name = format!(
            "{}.{}.tmp",
            target
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
            &suffix[..8]
        );
        let candidate = directory.join(name);
        if !candidate.exists() {
            return candidate;
        }
    }
    directory.join(format!(
        "{}.{:016x}.tmp",
        target
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        nanos
    ))
}

/// Replaces every asset token in `html` with a `data:<mime>;base64,…` URI and
/// writes the result to `dest` atomically (temp file + fsync + rename).
/// Returns the number of bytes written. Any `@@ASSET:` text that does not
/// match the strict grammar fails the whole export before `dest` is touched.
pub fn write_html(
    html: &str,
    dest: &Path,
    staging_root: &Path,
    open_zip: Option<&Path>,
) -> ProjectResult<u64> {
    // Validate the whole document (tokens + extensions) before touching the
    // filesystem so a malicious body never produces a partial export.
    let tokens = scan_tokens(html)?;
    for token in &tokens {
        if mime_for(&token.ext).is_none() {
            return Err(ProjectError::invalid_data(&[format!(
                "unknown asset extension '{}' in token near byte {}",
                token.ext, token.start
            )]));
        }
    }
    let directory = dest.parent().unwrap_or_else(|| Path::new("."));
    let temp = unique_temp_path(dest, directory);
    let outcome = write_tokenized(html, &tokens, &temp, staging_root, open_zip).and_then(|file| {
        let bytes = file
            .metadata()
            .map_err(|error| {
                ProjectError::with_detail(
                    "save_failed",
                    "The HTML export could not be written.",
                    format!("could not stat the temporary file: {error}"),
                )
            })?
            .len();
        file.sync_all().map_err(|error| {
            ProjectError::with_detail(
                "save_failed",
                "The HTML export could not be written.",
                error.to_string(),
            )
        })?;
        Ok(bytes)
    });
    let outcome = outcome.and_then(|bytes| {
        // The handle is dropped before the rename (Windows rename of an open
        // file needs share-delete, which we don't rely on).
        match fs::rename(&temp, dest) {
            Ok(()) => Ok(bytes),
            Err(error) => Err(ProjectError::with_detail(
                "save_failed",
                "The HTML export could not be written.",
                format!("could not replace {}: {error}", dest.display()),
            )),
        }
    });
    if outcome.is_err() {
        let _ = fs::remove_file(&temp);
    }
    outcome
}

fn write_tokenized(
    html: &str,
    tokens: &[Token],
    temp: &Path,
    staging_root: &Path,
    open_zip: Option<&Path>,
) -> ProjectResult<File> {
    let mut file = File::create(temp).map_err(|error| {
        ProjectError::with_detail(
            "save_failed",
            "The HTML export could not be written.",
            format!("could not create {}: {error}", temp.display()),
        )
    })?;
    let engine = base64::engine::general_purpose::STANDARD;
    let mut cursor = 0usize;
    for token in tokens {
        let bytes = blob_bytes(&token.hash, staging_root, open_zip)?;
        let mime = mime_for(&token.ext).expect("extension validated above");
        file.write_all(&html.as_bytes()[cursor..token.start])
            .and_then(|_| file.write_all(format!("data:{mime};base64,").as_bytes()))
            .and_then(|_| file.write_all(engine.encode(&bytes).as_bytes()))
            .map_err(|error| {
                ProjectError::with_detail(
                    "save_failed",
                    "The HTML export could not be written.",
                    error.to_string(),
                )
            })?;
        cursor = token.end;
    }
    file.write_all(&html.as_bytes()[cursor..])
        .map_err(|error| {
            ProjectError::with_detail(
                "save_failed",
                "The HTML export could not be written.",
                error.to_string(),
            )
        })?;
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::container::{write_container, BlobSource};
    use crate::project::schema::new_doc;
    use std::collections::BTreeMap;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "pcbre-html-{tag}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn token(hash: &str, ext: &str) -> String {
        format!("{TOKEN_PREFIX}{hash}.{ext}{TOKEN_SUFFIX}")
    }

    fn make_container(dir: &Path, name: &str, hash: &str, payload: &[u8]) -> PathBuf {
        let staging = dir.join("staging");
        fs::create_dir_all(&staging).unwrap();
        fs::write(staging.join(hash), payload).unwrap();
        let doc = new_doc("Html", "2026-11-15T00:00:00Z");
        let mut blobs = BTreeMap::new();
        blobs.insert(hash.to_string(), BlobSource::StagedFile(staging.join(hash)));
        let target = dir.join(name);
        write_container(&target, &serde_json::to_string(&doc).unwrap(), &blobs).unwrap();
        target
    }

    #[test]
    fn inlines_tokens_from_staging_and_the_open_container() {
        let dir = temp_dir("inline");
        let staging = dir.join("staging");
        let a_hash = "ab".repeat(32);
        let b_hash = "cd".repeat(32);
        // `a` is staged; `b` lives only inside the container zip.
        fs::create_dir_all(&staging).unwrap();
        fs::write(staging.join(&a_hash), b"staged-bytes").unwrap();
        let container = make_container(&dir, "project.pcbre", &b_hash, b"zipped-bytes");

        let html = format!(
            "<p>board {} and photo {}.</p>",
            token(&a_hash, "png"),
            token(&b_hash, "jpg")
        );
        let dest = dir.join("out.html");
        let bytes = write_html(&html, &dest, &staging, Some(&container)).unwrap();
        let written = fs::read_to_string(&dest).unwrap();
        assert_eq!(bytes as usize, written.len());
        assert!(written.contains("<p>board data:image/png;base64,"));
        let engine = base64::engine::general_purpose::STANDARD;
        assert!(written.contains(&engine.encode(b"staged-bytes".as_slice())));
        assert!(written.contains("data:image/jpeg;base64,"));
        assert!(written.contains(&engine.encode(b"zipped-bytes".as_slice())));
        assert!(!written.contains(TOKEN_PREFIX), "tokens must be replaced");
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rewrites_an_existing_destination_atomically() {
        let dir = temp_dir("rewrite");
        let staging = dir.join("staging");
        let hash = "ef".repeat(32);
        fs::create_dir_all(&staging).unwrap();
        fs::write(staging.join(&hash), b"v2").unwrap();
        let dest = dir.join("out.html");
        fs::write(&dest, b"previous export").unwrap();
        write_html(&token(&hash, "webp"), &dest, &staging, None).unwrap();
        assert!(fs::read_to_string(&dest).unwrap().contains("image/webp"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_blob_is_a_typed_error_and_keeps_the_destination() {
        let dir = temp_dir("missing");
        let staging = dir.join("staging");
        let dest = dir.join("out.html");
        fs::write(&dest, b"keep me").unwrap();
        let error = write_html(&token(&"11".repeat(32), "png"), &dest, &staging, None).unwrap_err();
        assert_eq!(error.code, "missing_blob");
        assert_eq!(fs::read(&dest).unwrap(), b"keep me");
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn adversarial_and_malformed_tokens_fail_as_invalid_data() {
        let dir = temp_dir("adversarial");
        let staging = dir.join("staging");
        let dest = dir.join("out.html");
        let good = "ff".repeat(32);
        fs::create_dir_all(&staging).unwrap();
        fs::write(staging.join(&good), b"ok").unwrap();
        // A refdes or note containing literal "@@ASSET:" text that does not
        // match the strict grammar must fail the export, never pass through.
        for body in [
            format!("price {} list", TOKEN_PREFIX),
            format!("refdes {}x.png@@", TOKEN_PREFIX),
            format!("refdes {}{}.pn@@", TOKEN_PREFIX, "a".repeat(32)),
            format!("refdes {}{}@@@", TOKEN_PREFIX, "a".repeat(32)),
            format!("note {}{}", TOKEN_PREFIX, "A".repeat(64)),
            format!("{}{}.pdf@@", TOKEN_PREFIX, "a".repeat(32)), // unknown ext
            format!(
                "{}{}.png@@ trailing {} broken",
                TOKEN_PREFIX,
                "a".repeat(32),
                TOKEN_PREFIX
            ),
        ] {
            let error = write_html(&body, &dest, &staging, None).unwrap_err();
            assert_eq!(error.code, "invalid_data", "body: {body}");
            assert!(!dest.exists(), "no partial export for: {body}");
        }
        // The same prefix embedded in a VALID token is fine.
        write_html(
            &format!("ok {} ok", token(&good, "png")),
            &dest,
            &staging,
            None,
        )
        .unwrap();
        assert!(dest.exists());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn token_scanner_requires_exact_hash_and_extension_grammar() {
        assert_eq!(scan_tokens("no tokens here").unwrap().len(), 0);
        let tokens = scan_tokens(&format!("a{}b", token(&"12".repeat(32), "jpeg"))).unwrap();
        assert_eq!(tokens.len(), 1);
        assert_eq!(tokens[0].hash, "12".repeat(32));
        assert_eq!(tokens[0].ext, "jpeg");
        // Two tokens in one document resolve independently.
        let two = format!(
            "{}{}",
            token(&"12".repeat(32), "png"),
            token(&"34".repeat(32), "bmp")
        );
        assert_eq!(scan_tokens(&two).unwrap().len(), 2);
    }
}
