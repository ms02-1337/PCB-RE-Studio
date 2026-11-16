# Decision 0007: Precise rotation and component image names

(A concurrent visual-editor feature took number 0006:
docs/decisions/0006-visual-editor-images.md.)

Date: 2026-11-16
Status: Accepted
Supersedes: none; extends 0003 (v1 additive board transforms)

## Context

The picture inspector needs rotation finer than quarter turns (±0.1° stepping),
and component photos need user-set display names. Both touch the persisted
project format and the shared transform pipeline.

## Decision

- `Board.rotation` changes from `u16` (0/90/180/270 only) to `f64` degrees,
  validated as finite and within `[0, 360)`. A custom serializer writes whole
  values as JSON integers, so files rotated by quarter turns stay
  byte-identical to what earlier builds wrote.
- `schemaVersion` stays 1: the change only relaxes an invariant while
  accepting every previously valid value; no migration code is needed.
- The transform pipeline generalizes rotation to an arbitrary angle by
  rotating about the crop-rect center and anchoring the rotated AABB at
  `sceneX/sceneY`. At 0/90/180/270 the mapping is exactly the legacy formula
  (quarter-turn basis vectors snap to exact integers), so geometry, hit
  testing, fit, scene placement, and HTML export frames are unchanged for
  existing projects. `displayToImage` is the exact inverse affine.
- Components gain an optional `imageNames` map (asset sha256 → label,
  camelCase `imageNames`): at most 64 entries, values at most 200 chars,
  empty string clears a name. Keys do not create blob references; image
  liveness still flows through `imageHashes`/`imageHash`, so garbage
  collection is unaffected.

## Consequences

- Older builds reject fine-rotated files (their validation allowed only
  quarter turns). No released versions exist, and quarter-turn files remain
  readable everywhere, so this forward-compatibility limit is accepted.
- The UI accumulates rotation in 0.1° steps and normalizes with round-half-up
  into `[0, 360)`; a value that rounds to 360 becomes 0.
- HTML export frames boards with the rotated AABB and emits
  `rotate(<θ>deg)` for arbitrary angles; the SVG shape overlay is unaffected
  because it stays in original image coordinates.
