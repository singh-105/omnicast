import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/signaling': {
        target: 'ws://127.0.0.1:10000',
        ws: true,
        changeOrigin: true,
      },
      '/api': {
        target: 'http://127.0.0.1:10000',
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: true,
    port: 5173,
    proxy: {
      '/signaling': {
        target: 'ws://127.0.0.1:10000',
        ws: true,
        changeOrigin: true,
      },
      '/api': {
        target: 'http://127.0.0.1:10000',
        changeOrigin: true,
      },
    },
  },
});
