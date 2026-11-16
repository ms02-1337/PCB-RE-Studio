# 0011 - Local import of downloaded KiCad files

Users download footprints and symbols from the internet and want to use them without installing them into their KiCad installation (copying files plus editing `fp-lib-table`/`sym-lib-table`). The component library browser offers Import, which copies picked `.kicad_mod`/`.kicad_sym` files into an app-managed local library under app data: footprints land in `kicad-local/Imported.pretty`, symbol files in the `kicad-local` root, so entry names follow KiCad library conventions (`Imported:R_0603`, `Device:R`).

Import validates fully before copying: footprints and every symbol in a file (bounded to 100 per import) must parse with supported electrical geometry, otherwise that file fails with a per-file diagnostic and nothing is copied for it. Copies are content-deduplicated: identical files reuse the stored copy, and a re-downloaded file with changed content coexists under a deterministic content-hash suffix. Entry identity comes from the shared `index_file` helper (hash of the canonical path plus symbol name), which rescans also use, so scanning the local source never duplicates imported entries.

The local library registers as a `LibrarySource` marked `local: true` (additive serde field; legacy registries load unchanged). It appears in the sources table as "Imported files", can be rescanned, and cannot be redirected or removed. Imports survive deletion of the original downloads, remain machine-local like all library data, and behave exactly like installation entries in search and loading.

Export stays self-contained per decision 0010: KiCad packages embed private symbols and project-local `PCBRE` libraries, so nothing needs to be installed into KiCad to open an export. See docs/decisions/0010-electrical-components.md.
