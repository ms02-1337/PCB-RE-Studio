# Validation record

2026-11-15, visual workbench implementation, Windows. Node 24.21.0 was used for frontend validation attempts; Rust 1.95.0 was initialized successfully.

Passed: cargo fmt --manifest-path src-tauri/Cargo.toml --check; cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings; cargo test --manifest-path src-tauri/Cargo.toml (one native unit test). Updated feature source and design/architecture documentation were formatted with Prettier. Independent source review found no actionable issues.

Frontend validation is blocked by dependency installation. npm 10 repeatedly crashed in peer resolution (edgesOut); npm 11 installation encountered repeated TAR_ENTRY_ERROR missing paths. A repair reported success, but lint, tests and build could not load missing dependency files. TypeScript found two unsupported test-query options, which were removed; the subsequent dependency repair failed before checks could rerun. The generated npm lockfile has not been validated with a successful clean install. The generated Cargo lockfile was exercised by the passing native checks.

Frontend tests, final typecheck, lint, build, browser visual QA and native window interaction smoke tests remain outstanding. The desktop test scenario was updated but not executed. No feature commit was created because required validation did not pass. The damaged dependency backup, where present, is under .cache/failed-node-modules.

2026-11-15, component marking tool and .pcbre persistence, Windows.

Passed: npm run check; npm run lint; npm test (87+ vitest tests across geometry, refdes, color, view, pointerController, the placement store including autosave single-flight and data-loss guards, the bridge, and panel component tests); npm run build; cargo fmt --manifest-path src-tauri/Cargo.toml --check; cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings; cargo test --manifest-path src-tauri/Cargo.toml (35 tests across schema, container, assets, and commands, including dedup, garbage collection, atomic replace, and corrupt-container handling).

Canvas painting and desktop-only flows (pickers, project file IO, save/reload) are covered by a manual smoke checklist; jsdom cannot verify rendering or native IPC, so real-desktop rendering and dialogs remain unverified by automated tests. The wdio desktop suite stays optional and was not part of this record.

2026-11-15, component image browsing and clipboard paste, Windows (Node 24.21.0, Rust 1.95.0).

Passed: npm run check; npm run lint; npm run build; cargo fmt --manifest-path src-tauri/Cargo.toml --check; cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings; cargo test --manifest-path src-tauri/Cargo.toml (50 tests). Targeted frontend validation passed 23 tests across the properties panel and project bridge; targeted Rust validation passed both clipboard tests, including bounds, deduplication, and component-image persistence. Independent review found no actionable issues.

Earlier parallel npm test runs timed out in the command-palette test in src/workbench/App.test.tsx at 5000 ms. The isolated App test file then passed all 9 tests, and npm test -- --no-file-parallelism passed all 357 tests across 23 files. Actual OS clipboard access, native image picker interaction, and narrow desktop layout have not been exercised.

The feature-only patch could not be applied to the Git index because it overlaps pre-existing uncommitted changes. A three-way reconstruction also conflicts and would need adaptation against the older committed interfaces; current working-tree validation does not validate that reconstruction. No local commit was created, and unrelated changes were preserved.

2026-11-15, project management, board transforms, and HTML export batch — documentation gate note. The documentation pass ran no checks and records no results; the recorded validation evidence remains the authority for this batch. Desktop-only flows without a recorded smoke run: standalone HTML export (token inlining, atomic replace, opening the file in a browser), export copy, project delete and its recents cleanup, recent-project reopen with unsaved changes, canvas rendering under crop/rotation/flip/scale, and the Projects tab actions behind native dialogs. The exported report's mouse-only board tabs are a documented accessibility limitation.

2026-11-15, tab-local navigation and inspector layout, Windows.

Explorer/Search and the primary sidebar now belong to Projects, Board mapping retains its own properties inspector, and the global Inspector is removed. The title-bar Settings gear opens the existing in-app autosave dialog. Projects and Board mapping hosts explicitly stretch their content to the available workspace height.

Passed: npm run check; npm run lint; npm run build; 40 targeted frontend tests; all 364 frontend tests across 23 files via node node_modules/vitest/vitest.mjs run --no-file-parallelism; cargo fmt --manifest-path src-tauri/Cargo.toml --check; cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings. Independent review found no actionable issues and independently passed all 11 App tests.

Native validation is blocked: cargo test --manifest-path src-tauri/Cargo.toml passed 51 tests and failed commands::tests::delete_clears_state_even_when_staging_cannot_be_cleared at src-tauri/src/commands.rs:512. The test expects clear_staging(&staging).is_err() for a path beneath a plain file, but it returns no error on this Windows host; an isolated rerun also failed. This UI change does not modify native code.

Actual rendered geometry, resizing, and narrow-layout overflow remain unverified because the running desktop app was minimized and could not be captured. WDIO scope and geometry checks were updated but not run. No local feature commit was created: required native validation fails, and the feature overlaps pre-existing uncommitted work. Unrelated changes were preserved.
