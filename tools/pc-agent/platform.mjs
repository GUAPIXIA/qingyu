// 平台与构建身份：路径解析、环境清理、构建陈旧检测。
// 阶段 0 实测结论（见 docs/报告/PC端外部Agent工具阶段0实施报告-2026-10-03.md）：
//  - 启动 Electron 前必须清除 ELECTRON_RUN_AS_NODE，否则 electron.exe 退化为纯 Node；
//  - 源码启动恒为 dev 渲染层（main.ts 的 isDev 分流），发布产物只能由打包版加载；
//  - app.getVersion() 在注入 launcher 时返回 Electron 版本，不能作为构建身份。
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

export const REPO_ROOT = resolve(HERE, '..', '..')
export const OUTPUT_ROOT = resolve(REPO_ROOT, 'output', 'pc-agent')
export const CATALOG_DIR = resolve(HERE, 'catalog')
export const EXCLUSIONS_PATH = resolve(HERE, 'catalog.exclusions.json')
export const MATRIX_PATH = resolve(REPO_ROOT, 'docs', 'pc-agent', '能力矩阵.md')
export const REGISTRY_PATH = resolve(OUTPUT_ROOT, 'registry.json')

export const SUPPORTED_PLATFORM = 'win32'
export const PROFILES = ['source-isolated', 'packaged-isolated']

const SOURCE_ROOTS = ['src', 'electron', 'shared', 'vite.config.ts']
const BUILD_ARTIFACTS = [
  'dist/index.html',
  'dist-electron/main.cjs',
  'dist-electron/preload.cjs',
]

export function assertSupportedPlatform() {
  if (process.platform !== SUPPORTED_PLATFORM) {
    const error = new Error(`首版仅支持 ${SUPPORTED_PLATFORM}，当前为 ${process.platform}（UNSUPPORTED_PLATFORM）`)
    error.code = 'UNSUPPORTED_PLATFORM'
    throw error
  }
}

export function electronExecutable() {
  return resolve(REPO_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
}

export function packagedExecutable() {
  return resolve(REPO_ROOT, 'release-v2', 'win-unpacked', '轻语.exe')
}

/** 启动 Electron 用的环境：必须清除宿主注入的 ELECTRON_RUN_AS_NODE */
export function sanitizedEnv() {
  const env = { ...process.env }
  const leaked = env.ELECTRON_RUN_AS_NODE ?? null
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ATTACH_CONSOLE
  return { env, sanitized: { ELECTRON_RUN_AS_NODE: leaked } }
}

function newestSourceMtime() {
  let newest = 0
  let newestPath = null
  const walk = (absPath) => {
    if (!existsSync(absPath)) return
    const stat = statSync(absPath)
    if (stat.isFile()) {
      if (stat.mtimeMs > newest) {
        newest = stat.mtimeMs
        newestPath = absPath
      }
      return
    }
    for (const entry of readdirSync(absPath, { withFileTypes: true })) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue
      if (/\.(test|spec)\./.test(entry.name)) continue
      walk(join(absPath, entry.name))
    }
  }
  for (const relative of SOURCE_ROOTS) walk(resolve(REPO_ROOT, relative))
  return { mtimeMs: newest, path: newestPath }
}

/** 构建身份与陈旧判定；陈旧时 stale=true 并给出原因 */
export function buildIdentity() {
  const source = newestSourceMtime()
  const artifacts = BUILD_ARTIFACTS.map((relative) => {
    const absPath = resolve(REPO_ROOT, relative)
    if (!existsSync(absPath)) return { path: relative, exists: false }
    const stat = statSync(absPath)
    return { path: relative, exists: true, mtimeMs: stat.mtimeMs, mtime: stat.mtime.toISOString(), size: stat.size }
  })

  const missing = artifacts.filter((item) => !item.exists).map((item) => item.path)
  const staleArtifacts = artifacts
    .filter((item) => item.exists && item.mtimeMs < source.mtimeMs)
    .map((item) => item.path)

  const git = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' })
  const gitCommit = git.status === 0 ? git.stdout.trim() : null

  const packaged = packagedExecutable()
  const packagedInfo = existsSync(packaged)
    ? { path: packaged, mtimeMs: statSync(packaged).mtimeMs, mtime: statSync(packaged).mtime.toISOString() }
    : { path: packaged, exists: false }

  return {
    repoRoot: REPO_ROOT,
    gitCommit,
    node: process.version,
    electron: existsSync(electronExecutable()) ? readElectronVersion() : null,
    newestSource: { path: source.path ? source.path.slice(REPO_ROOT.length + 1).replace(/\\/g, '/') : null, mtime: source.mtimeMs ? new Date(source.mtimeMs).toISOString() : null },
    artifacts,
    packaged: packagedInfo,
    stale: missing.length > 0 || staleArtifacts.length > 0,
    staleReasons: [
      ...missing.map((item) => `构建产物缺失：${item}`),
      ...staleArtifacts.map((item) => `构建产物早于源码：${item}`),
    ],
  }
}

function readElectronVersion() {
  try {
    return JSON.parse(readFileSync(resolve(REPO_ROOT, 'node_modules', 'electron', 'package.json'), 'utf8')).version
  } catch {
    return null
  }
}
