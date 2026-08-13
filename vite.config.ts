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
  esbuild: {
    // 优化：静默 Duplicate attribute 警告。开发模式下 react-dev-locator 与 react-refresh/babel
    // 共存时会向每个 JSX 元素重复注入 3 组 trae-inspector-* 属性，esbuild 对每处重复属性
    // 打印一条含超长代码帧的 warning，导致终端刷屏（功能不受影响，仅注入冗余）。
    // 若不再使用 Trae 的“点击元素跳转源码”功能，可删除下方 react({ babel: ... }) 中的
    // react-dev-locator 插件，即可一并删除本段配置。
    logOverride: {
      'duplicate-object-key': 'silent',
    },
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
