import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: './',
  plugins: [
    react(),
    {
      name: 'remove-unused-supabase-localhost-default',
      renderChunk(code) {
        return code.includes('http://localhost:9999')
          ? { code: code.replaceAll('http://localhost:9999', 'https://auth.invalid'), map: null }
          : null
      },
    },
  ],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('@supabase')) return 'supabase'
          if (id.includes('/qrcode/') || id.includes('\\qrcode\\')) return 'qrcode'
          if (id.includes('/react/') || id.includes('\\react\\') || id.includes('react-dom')) return 'react'
        },
      },
    },
  },
  test: {
    environment: 'node',
    globals: true,
  },
})
