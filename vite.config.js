import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const pkg = JSON.parse(
  readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf-8')
)

export default defineConfig({
  server: {
    port: 1420,
    strictPort: true,
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // Manual registration in src/main.jsx so we can skip the SW entirely
      // when running inside Tauri — the desktop build bundles assets in the
      // .exe, and a stale SW would block auto-updates from taking effect.
      injectRegister: null,
      manifest: {
        name: 'Tarkov Planner',
        short_name: 'TarkovPlanner',
        description: 'PvE Field Reference — Squad Route Planner',
        theme_color: '#07090b',
        background_color: '#07090b',
        display: 'standalone',
        orientation: 'portrait',
        icons: [
          { src: '/icon-192.svg', sizes: '192x192', type: 'image/svg+xml' },
          { src: '/icon-512.svg', sizes: '512x512', type: 'image/svg+xml' }
        ]
      }
    })
  ],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          leaflet: ['leaflet'],
          supabase: ['@supabase/supabase-js'],
        }
      }
    }
  }
})
