# ADR 0005: Mapping tabs contain image scenes

Status: accepted, 2026-11-15.

A Board mapping tab represents a scene containing zero or more movable images. Importing an image adds it to the active scene; the adjacent bottom `+` creates an empty tab independently of image import. New projects begin with one empty tab, and deleting the final tab leaves an empty replacement.

Keep `Board` as the image record and preserve `Component.boardId` as image ownership. Add optional project fields `mappingTabs: [{ id, name, boardIds }]` and `activeMappingTabId`, plus optional finite `sceneX`/`sceneY` coordinates on each image. Translation follows the existing crop → rotation → flip → scale transform. Component geometry stays in original image pixels, so moving an image carries its markings without coordinate rewrites or accumulated rounding.

The additive fields keep schemaVersion at 1. The frontend normalizes legacy projects without tabs into one tab per existing image, preserving their former independent views. Empty projects receive one empty tab, and ungrouped images are attached to the first tab so none become inaccessible. Rust validates tab identifiers, image references, unique image membership, and finite placement coordinates while accepting legacy documents without scene fields.

Canvas rendering, reverse-order hit testing, whole-scene Fit, and standalone HTML export use the same tab membership and image positions. Image dragging keeps its draft outside reactive document state and commits once on pointer-up. The active scene retains its decoded image resources and releases stale loads. This extends the existing Canvas 2D renderer without introducing another canvas framework.

Consequences: tab lifecycle and image lifecycle are separate. Deleting a tab removes its images and components after confirmation; deleting a selected image preserves the tab and its other images. Readers that ignore the new fields can still read the image records but cannot reproduce scene grouping or placement.
