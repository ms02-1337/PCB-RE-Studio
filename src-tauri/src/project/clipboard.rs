//! Native image clipboard access and bounded PNG staging. No pixels cross IPC.
use super::error::{ProjectError, ProjectResult};
use super::schema::AssetInfo;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;

const MAX_DIMENSION: usize = 16_384;
const MAX_RGBA_BYTES: usize = 64 * 1024 * 1024;

fn clipboard_error(error: impl ToString) -> ProjectError {
    ProjectError::with_detail(
        "clipboard_unavailable",
        "The clipboard image could not be read. Copy an image and try again.",
        error.to_string(),
    )
}

pub fn read_png() -> ProjectResult<Vec<u8>> {
    let mut clipboard = arboard::Clipboard::new().map_err(clipboard_error)?;
    let image = clipboard.get_image().map_err(|error| match error {
        arboard::Error::ContentNotAvailable => ProjectError::new(
            "clipboard_no_image",
            "The clipboard does not contain a supported image. Copy an image and try again.",
        ),
        other => clipboard_error(other),
    })?;
    encode_png(image.width, image.height, image.bytes.as_ref())
}

pub fn encode_png(width: usize, height: usize, rgba: &[u8]) -> ProjectResult<Vec<u8>> {
    let bytes = width
        .checked_mul(height)
        .and_then(|pixels| pixels.checked_mul(4));
    if width == 0
        || height == 0
        || width > MAX_DIMENSION
        || height > MAX_DIMENSION
        || bytes.is_none_or(|size| size > MAX_RGBA_BYTES || size != rgba.len())
    {
        return Err(ProjectError::new(
            "clipboard_invalid_image",
            "The clipboard image is invalid or too large (maximum 16 megapixels and 16384 pixels per side).",
        ));
    }
    let mut output = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut output, width as u32, height as u32);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(clipboard_error)?;
        writer.write_image_data(rgba).map_err(clipboard_error)?;
    }
    Ok(output)
}

pub fn stage_png(bytes: &[u8], root: &Path) -> ProjectResult<AssetInfo> {
    let hash = format!("{:x}", Sha256::digest(bytes));
    fs::create_dir_all(root)?;
    let target = root.join(&hash);
    if !target.is_file() {
        let temp = root.join(format!("{hash}.clipboard"));
        fs::write(&temp, bytes)?;
        if let Err(error) = fs::rename(&temp, &target) {
            let _ = fs::remove_file(temp);
            return Err(error.into());
        }
    }
    Ok(AssetInfo {
        hash,
        size: bytes.len() as u64,
        name: "clipboard.png".to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_invalid_dimensions_buffers_and_resource_limits() {
        for (width, height, data) in [
            (0, 1, &[][..]),
            (1, 1, &[0, 0, 0][..]),
            (MAX_DIMENSION + 1, 1, &[][..]),
            (8192, 8192, &[][..]),
            (usize::MAX, 2, &[][..]),
        ] {
            assert_eq!(
                encode_png(width, height, data).unwrap_err().code,
                "clipboard_invalid_image"
            );
        }
    }

    #[test]
    fn stages_png_once_and_survives_container_roundtrip() {
        let dir = std::env::temp_dir().join(format!(
            "pcbre-clipboard-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let staging = dir.join("staging");
        let png = encode_png(1, 1, &[255, 0, 0, 255]).unwrap();
        assert!(png.starts_with(b"\x89PNG\r\n\x1a\n"));
        let info = stage_png(&png, &staging).unwrap();
        assert_eq!(stage_png(&png, &staging).unwrap().hash, info.hash);
        assert_eq!(fs::read_dir(&staging).unwrap().count(), 1);
        let mut doc = super::super::schema::new_doc("Clipboard", "2026-11-15T00:00:00Z");
        doc.assets.insert(info.hash.clone(), info.clone());
        doc.boards.push(super::super::schema::Board::plain(
            "b1", "Front", &info.hash, 1, 1,
        ));
        doc.active_board_id = Some("b1".into());
        doc.components.push(
            serde_json::from_value(serde_json::json!({
                "id": "c1", "boardId": "b1", "refdes": "U1", "typeId": "ic",
                "shape": { "rect": { "x": 0, "y": 0, "w": 1, "h": 1 } },
                "status": "identified", "locked": false, "imageHash": info.hash
            }))
            .unwrap(),
        );
        let target = dir.join("clipboard.pcbre");
        super::super::save_doc(&mut doc, &target, None, &staging, "2026-11-15T00:00:00Z").unwrap();
        let (loaded, hashes) = super::super::load_doc(&target).unwrap();
        assert_eq!(loaded.boards[0].asset_hash, info.hash);
        assert_eq!(loaded.components[0].image_hash.as_ref(), Some(&info.hash));
        assert_eq!(hashes, vec![info.hash.clone()]);
        assert_eq!(
            super::super::assets::read_from_container(&target, &info.hash).unwrap(),
            png
        );
        fs::remove_dir_all(dir).unwrap();
    }
}
