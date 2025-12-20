import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Use relative base so assets resolve correctly in Capacitor WebView
  base: './',
  server: {
    port: 3000
  }
})
