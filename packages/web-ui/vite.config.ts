import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/rag': {
        target: 'http://localhost:8787',
        changeOrigin: true
      },
      '/chat': {
        target: 'http://localhost:8787',
        changeOrigin: true
      },
      '/models': {
        target: 'http://localhost:8787',
        changeOrigin: true
      },
      '/health': {
        target: 'http://localhost:8787', 
        changeOrigin: true
      }
    }
  }
})