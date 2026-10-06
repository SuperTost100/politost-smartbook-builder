import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // SSE passes through the proxy as a plain streaming response.
      '/api': { target: 'http://127.0.0.1:5300', changeOrigin: false },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
});
