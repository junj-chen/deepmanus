import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // `@/*` path alias required by shadcn/ui components (JS project).
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    // Listen on all interfaces so the app is reachable from a phone on the
    // same LAN (e.g. http://192.168.1.11:5173).
    host: true,
    port: 5173,
    // Proxy the CopilotKit runtime calls to the Express middleware layer.
    proxy: {
      '/api/copilotkit': {
        target: 'http://127.0.0.1:4000',
        changeOrigin: true,
      },
      // Also proxy the sessions API (used by the mobx SessionStore) to the
      // Python backend so the phone reaches it via the frontend host.
      '/sessions': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
      // Team group-chat API (SSE stream + messages).
      '/teams': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
    },
  },
})
