# PCB RE Studio
Tauri 2 + SolidJS desktop application for PCB reverse engineering. PCB workflows and formats will be specified later.

## Prerequisites
Node 24 LTS (see .nvmrc), npm, Rust 1.95.0, and Tauri platform dependencies: https://v2.tauri.app/start/prerequisites/
Windows needs MSVC C++ build tools and WebView2; Linux needs the documented WebKitGTK/build packages; macOS needs Xcode command line tools. Tool/version selection is local to your environment; nothing here changes global defaults.

## Run
npm install (first bootstrap; use npm ci after committing package-lock.json)
npm run dev ? browser preview, explicitly reports Browser preview metadata
npm run tauri -- dev ? desktop application
npm run tauri -- build --no-bundle ? production executable
npm run desktop:build ? dedicated desktop test binary
npm run test:desktop ? native smoke tests after desktop:build

See CONTRIBUTING.md for checks and docs/architecture.md for boundaries. Native application metadata and workbench controls are implemented; no PCB import/processing functionality is claimed.

## First bootstrap in an unrestricted environment
Select Node 24, then run npm install, npm run format, npm run check, npm run lint, npm test, and npm run build. Generate src-tauri/Cargo.lock with cargo generate-lockfile --manifest-path src-tauri/Cargo.toml. Commit both real lockfiles and formatted source before feature development. See docs/validation.md for the checks blocked in the setup environment.
