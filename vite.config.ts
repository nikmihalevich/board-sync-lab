import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Excalidraw otherwise falls back to a public font CDN. Serve packaged fonts
// locally in both development and the production build.
const packageDirectory = dirname(fileURLToPath(import.meta.resolve('@excalidraw/excalidraw')));
mkdirSync(resolve('public/excalidraw'), { recursive: true });
cpSync(resolve(packageDirectory, 'fonts'), resolve('public/excalidraw/fonts'), { recursive: true });

const proxy = {
  '/sync': { target: `ws://127.0.0.1:${process.env.SYNC_PORT ?? 1234}`, ws: true },
  '/api': { target: `http://127.0.0.1:${process.env.SYNC_PORT ?? 1234}` },
};

export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true, proxy },
  build: { chunkSizeWarningLimit: 2500 },
});
