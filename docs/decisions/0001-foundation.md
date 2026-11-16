# ADR 0001: desktop foundation
Status: accepted, 2026-11-15.
Choose Tauri 2, SolidJS, strict TypeScript, Vite, CSS tokens, npm, Node 24 LTS, and Rust 1.95.0. Commit npm and Cargo lockfiles.
Solid's fine-grained updates fit a dense interactive workbench. Svelte offers efficient compiled components; React offers the broadest ecosystem but requires more care around rerenders. This is an engineering choice, not proof of universal benchmark superiority. DOM table benchmarks do not establish PCB rendering performance.
Desktop targets: Windows, Linux, macOS. No PCB domain, storage, GPU, or file-format decisions yet.
Before setting performance budgets, record cold/warm startup to interactive, compressed JS/CSS size, idle/loaded memory, and interaction latency with OS, webview version, hardware, build mode, and fixture dimensions. Track regressions against a repeatable baseline; do not invent PCB workload limits.
