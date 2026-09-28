import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const SERVER = 'http://127.0.0.1:4317';

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Dev and build read the shared sources directly, so editing shared needs no rebuild.
    alias: { '@manga/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)) },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      // F1 (controller ruling): the server's Host/Origin guard (api/guards.ts) answers 403 to every
      // proxied /api request and to the /api/events upgrade unless the proxy rewrites both Host
      // (changeOrigin) and Origin (headers.origin, lowercase so it overrides the browser's header).
      '/api': { target: SERVER, ws: true, changeOrigin: true, headers: { origin: SERVER } },
      '/files': { target: SERVER, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: true },
});
