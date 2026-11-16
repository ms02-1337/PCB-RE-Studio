# Decision 0008: Visual editor image transforms

Date: 2026-11-16
Status: Accepted
Extends: 0006 (visual editor images), 0003 (v1 additive board transforms)

## Context

The Visual editor needs Measure, Calibrate, Rotate, Align (4-point), Crop and
Resize tools over its photographs (Deskew stays unimplemented). Photos must be
comparable across sources: mirrored back-side shots, different resolutions,
unknown scale. The reference workflow (PCB-RevEng) bakes pixels into new
bitmaps for crop/deskew and stores a free `warp` matrix per layer; this repo
already has a non-destructive, render-time transform pipeline for Board
mapping (0003) and a strict asset boundary where image bytes never cross JS.

## Decision

- `VisualImage` gains additive optional fields, all `skip_serializing_if`
  absent so legacy files stay byte-identical on reload+save:
  `crop` (source-image px rect, u32 semantics, non-destructive — cropped-away
  pixels stay in the file and are recoverable by re-cropping wider),
  `rotation` (degrees CW, finite `[0, 360)`), `scaleX`/`scaleY` (per-axis,
  `(0, 100]`), and `warp` (2×2 linear `{a,b,c,d}` in canvas transform order,
  `|det| > 1e-9`, negative determinants allowed for mirrored mappings).
  `VisualPcb` gains `pxPerMm` (world px per real mm, finite > 0). Rust
  validates every present value; `schemaVersion` stays 1.
- Fixed render-time pipeline, all about the crop-rect center:
  `local = source − cropCenter`; `L = warp · F(flipH,flipV) · R(rotation) ·
  S(scaleX,scaleY)`; `world = L · local + anchor` with
  `anchor = (x + cropCenter.x, y + cropCenter.y)`. Flips apply in displayed
  (post-rotation) axes exactly like Board mapping, so pictures flip the same
  way in both tabs; per-axis scale applies in source axes, while resize's
  world-axis scaling folds into `warp` (outermost). At identity (all fields
  absent) this reproduces the legacy top-left placement exactly, so no
  migration is needed. World-space rotate deltas commit into `warp` when a
  warp exists or a single-axis flip blocks folding, else into `rotation`.
- Align solves a least-squares affine T from 4 clicked features on the moving
  image to 4 clicked references (normal equations; collinear input aborts) and
  composes left: `warp' = A · (warp ?? I)`, `anchor' = A · anchor + (e,f)`,
  which moves only `x`/`y` and `warp`. Rotation, flips and scales are never
  rewritten, so align is incremental and reversible; mirroring falls out of
  the solve naturally.
- Rotate applies world-space deltas about the anchor: into `warp` when one is
  present, else into `rotation` (so quarter-turn-ish files keep small field
  sets). Resize (two known-dimension reference lines, one per axis) folds
  `diag(fx,fy)` into `warp` the same way; when the PCB is uncalibrated the
  first entered axis sets `pxPerMm` instead of scaling (auto-calibration).
- Calibrate is a PCB-level scale (not a per-image rescale): measuring a known
  span and entering its real length sets `pxPerMm = span / mm`. Measure
  displays px always and mm only when calibrated.
- View flips (toolbar buttons) mirror the whole canvas about its center for
  rendering and pointer mapping only; they are component-local UI state,
  never persisted, never marked dirty, and flip future canvas content
  (e.g., components) with the photos.
- Transform tools are pure modules: `transform.ts` (math only) and
  `toolController.ts` (DOM-free state machine emitting commit intents and
  overlay descriptors), mirroring the placement pointer-controller/transform
  split. Every user gesture commits at most one document mutation, so undo
  history stays 1:1 with gestures.

## Consequences

- Crop is non-destructive and cheap to undo (one rect per gesture); it
  deviates from the reference app's pixel baking by design — pixels never
  cross IPC, no new assets are created, and crop never invalidates other
  images' alignments.
- Transforming an image that participates in an alignment can visually break
  that alignment; the UI warns before Rotate/Align/Crop/Resize when the target
  or any sibling image carries a warp (the future component-placement warning
  generalizes this).
- A skewed `warp` makes `rotation`/`scale` fields insufficient to describe
  the image, which is why `warp` composes outside them; the inspector shows
  derived values from the composed matrix, not the raw fields.
- `hitVisualImage` gained an optional world→source mapper so hit testing is
  crop- and transform-aware; the default keeps the legacy behavior for
  callers without transforms.
