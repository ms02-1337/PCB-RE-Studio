# Contributing
Use Node 24 and npm install (first bootstrap; use npm ci after committing package-lock.json); run npm run check, npm run lint, npm run format:check, npm test, and npm run build.
Native checks: cargo fmt --manifest-path src-tauri/Cargo.toml --check; cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings; cargo test --manifest-path src-tauri/Cargo.toml --locked.
Run npm run desktop:build then npm run test:desktop for native integration. Production builds must use default features, never desktop-test.
Keep patches focused, add behavior-level tests when warranted, and update affected documentation. Use architecture decisions for enduring tradeoffs. Never commit private board assets or credentials. Small redistributable fixtures may be tracked; large datasets require an explicit storage decision.
Do not claim CI passed until it has run. No license is selected yet.
