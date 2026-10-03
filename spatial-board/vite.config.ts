import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 独立端口，不占用 PC 的 5173
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5188,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
