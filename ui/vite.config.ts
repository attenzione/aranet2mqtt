import { fileURLToPath } from 'node:url';

import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  root: here('.'),
  plugins: [preact()],
  build: {
    outDir: here('../dist/ui'),
    emptyOutDir: true,
  },
  server: {
    // `pnpm dev` runs the API on 8080; the UI dev server forwards to it.
    proxy: { '/api': 'http://localhost:8080' },
  },
});
