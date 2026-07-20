import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// `AUDIBIAN_UI_MOCK=1 pnpm dev` swaps the Tauri bridge for the fixtures in
// src/dev/, so the UI can be opened in a plain browser and resized freely.
// The alternative — a second real instance via `cargo tauri dev` — fights the
// running Audibian for the PipeWire graph and leaves duplicate pactl modules
// behind, so it is not usable while the app is in daily use.
//
// The alias only applies when the flag is set; production builds never see it.
const mockTauri = process.env.AUDIBIAN_UI_MOCK === '1'

const resolvePath = p => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: mockTauri
      ? {
          '@tauri-apps/api/core': resolvePath('./src/dev/tauri-mock-core.js'),
          '@tauri-apps/api/event': resolvePath('./src/dev/tauri-mock-event.js'),
        }
      : {},
  },
  clearScreen: false,
  server: {
    // Force IPv4. Vite's default on dual-stack hosts binds only to
    // `[::1]:5173`; tauri's webview resolves `localhost` IPv4-first
    // and gets "Connection refused" even though vite is up.
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: ['es2021', 'chrome105', 'safari13'],
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
})
