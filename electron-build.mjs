import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'

// 确保 dist-electron 目录存在
mkdirSync('dist-electron', { recursive: true })

// 共享配置
const sharedConfig = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['electron'],
  sourcemap: true,
  logLevel: 'info',
}

// 编译主进程和预加载脚本
await Promise.all([
  build({
    ...sharedConfig,
    entryPoints: ['electron/main.ts'],
    outfile: 'dist-electron/main.cjs',
  }),
  build({
    ...sharedConfig,
    entryPoints: ['electron/preload.ts'],
    outfile: 'dist-electron/preload.cjs',
  }),
])

console.log('✓ Electron 编译完成')
