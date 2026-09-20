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
    // 静默 Duplicate attribute 警告：QINGYU_DEV_LOCATOR=1 打开 react-dev-locator 时，
    // 它会与 react-refresh/babel 一起向每个 JSX 元素重复注入 3 组 trae-inspector-* 属性，
    // esbuild 对每处重复属性打印一条含超长代码帧的 warning，导致终端刷屏（仅注入冗余）。
    logOverride: {
      'duplicate-object-key': 'silent',
    },
  },
  plugins: [
    react({
      babel: {
        // react-dev-locator 是 Trae IDE「点击元素跳转源码」用的 Babel 插件。
        // 代价是**每个模块多走一次 Babel**：2026-09-20 实测 dev 冷启动 +2.3 s（6.6 s → 4.3 s）。
        // 因此默认关闭；需要时 `QINGYU_DEV_LOCATOR=1 pnpm electron:dev` 打开。
        plugins: mode === 'development' && process.env.QINGYU_DEV_LOCATOR === '1' ? ['react-dev-locator'] : [],
      },
    }),
    tsconfigPaths()
  ],
  server: {
    port: 5173,
    strictPort: true,
    /**
     * watch.ignored：只把**源码目录**留在监听里。
     *
     * 2026-09-20 实测（同机、真实数据副本）：仓库根目录累计了约 **15 万个非源码文件**
     * （`.tmp-archive` 12.7 万、`android/app/build` 1.5 万，另有 release-v2 压缩包、
     * 合并前备份、coverage 等）。chokidar 冷启动要爬完整棵树，期间 Vite 的模块转换被 I/O
     * 饿死——`/src/main.tsx` 单次转换 115 s、Electron 首屏 **130 s**。把下列重目录排除后，
     * 同一条件下首屏 6.6 s；叠加上面关掉 Babel 插件，降到 4.3 s。
     *
     * 列出的目录没有一个是 HMR 目标；`ignored` 只影响 watch，不影响 serve 与 build
     * （`png/`、`models/` 等仍可被正常读取，`pnpm build` 不受影响）。
     */
    watch: {
      ignored: [
        '**/models/**', // 本地模型（数百 MB ONNX）；原有规则，保留
        '**/node_modules/**',
        '**/.git/**',
        '**/.tmp-*/**', // 测试演练副本：每次跑测试留下约 2500 个文件，中断即残留
        '**/.tmp-archive/**', // 上述残留的统一归档目录（12.7 万文件）
        '**/合并前备份-*/**',
        '**/android/**', // Gradle 构建产物（1.5 万文件）
        '**/release-v2/**',
        '**/dist/**',
        '**/dist-electron/**',
        '**/relay-server/dist/**',
        '**/coverage/**',
        '**/output/**',
        '**/png/**',
        '**/__pycache__/**',
        '**/.qa/**',
        '**/.qa-poc/**',
        '**/.playwright-cli/**',
        '**/.mimosa/**',
        '**/.zcode/**',
      ],
    },
  },
}))
