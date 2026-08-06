import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tsconfigPaths from "vite-tsconfig-paths";

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  // Electron 通过 file:// 加载，需使用相对路径
  base: './',
  build: {
    // 优化：生产构建不产出 sourcemap（'hidden' 会生成 5MB+ 的 .map 文件占用 asar 体积）
    sourcemap: false,
    outDir: 'dist',
    // 优化：路由懒加载生效——chunk 大于 400KB 时提示拆分（默认 500KB 告警）
    chunkSizeWarningLimit: 600,
  },
  plugins: [
    react({
      babel: {
        // 优化：react-dev-locator 仅开发模式注入（生产构建移除，减小产物并去掉源码位置信息）
        plugins: mode === 'development' ? ['react-dev-locator'] : [],
      },
    }),
    tsconfigPaths()
  ],
  server: {
    port: 5173,
    strictPort: true,
  },
}))
