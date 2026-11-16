# 0010 — Portable electrical component snapshots

App-local component definitions combine normalized KiCad footprints, symbols, explicit terminal mappings and metadata. Instances preserve revisions; importing or editing a local definition never silently changes a project. Project container encoding interns definitions by content hash, with verified hydration before normal schema validation.

Stable component IDs and numbered terminal IDs unify physical copper, schematic nets and BOM identity. Schematic layout is independent of physical placement. All symbol units belong to one PCB component. Power assignment is explicit. Pads with equal numbers share a terminal; mechanical pads do not create terminals.

Modern KiCad 6–9 libraries are parsed natively with bounded resource use and explicit unsupported-feature diagnostics. Export targets KiCad 9, private project-local libraries and explicit net labels. Unsupported geometry must not be silently approximated for electrical connectivity. Board mapping links are explicit and optional.
