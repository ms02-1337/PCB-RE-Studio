/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';
export default defineConfig({ plugins: [solid()], clearScreen: false, server: { port: 1420, strictPort: true, host: '127.0.0.1' }, envPrefix: ['VITE_', 'TAURI_ENV_'], build: { target: ['es2021', 'safari14'] }, test: { environment: 'jsdom', globals: true, setupFiles: ['./src/test-setup.ts'] } });
