// 阶段 0 探针公共设施：run 目录、证据、指纹、Playwright 装载。
//
// 注意（依赖归属）：阶段 0 探针临时复用 spatial-board 安装中的 Playwright，
// 只为验证“外部驱动能否操作现有应用”，不作为工具包的长期依赖。
// 工具包自持依赖从阶段 1 开始（见 tools/pc-agent/README.md §5）。
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(HERE, '..', '..', '..', '..')
export const PROBE_ROOT = resolve(REPO_ROOT, 'output', 'pc-agent', 'phase0')
export const ELECTRON_EXE = resolve(REPO_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
export const PACKAGED_EXE = resolve(REPO_ROOT, 'release-v2', 'win-unpacked', '轻语.exe')
export const PROD_USER_DATA = [
  join(process.env.APPDATA ?? '', '轻语'),
  join(process.env.APPDATA ?? '', 'qingyu'),
]

export function stamp() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

export function createRunDir(label) {
  const dir = resolve(PROBE_ROOT, `${label}-${stamp()}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

export function writeJson(absPath, value) {
  mkdirSync(dirname(absPath), { recursive: true })
  writeFileSync(absPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

export function writeText(absPath, value) {
  mkdirSync(dirname(absPath), { recursive: true })
  writeFileSync(absPath, value, 'utf8')
}

/** 目录指纹：用于证明操作前后没有动过正式数据目录 */
export function dirSignature(absPath) {
  if (!existsSync(absPath)) return { path: absPath, exists: false }
  const stat = statSync(absPath)
  let files = 0
  let bytes = 0
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else {
        files += 1
        try {
          bytes += statSync(full).size
        } catch {
          // 并发写入时忽略
        }
      }
    }
  }
  try {
    walk(absPath)
  } catch {
    // 目录被占用时只保留 mtime
  }
  return { path: absPath, exists: true, mtime: stat.mtime.toISOString(), entries: readdirSync(absPath).length, files, bytes }
}

export function sameSignature(before, after) {
  return (
    before.exists === after.exists &&
    before.mtime === after.mtime &&
    before.entries === after.entries &&
    before.files === after.files
  )
}

export function loadPlaywright() {
  const require = createRequire(resolve(REPO_ROOT, 'spatial-board/package.json'))
  const playwright = require('playwright')
  return { electron: playwright._electron, chromium: playwright.chromium }
}

/**
 * 启动 Electron 用的环境变量。
 * 必须删除 ELECTRON_RUN_AS_NODE：本机（DSH 宿主本身跑在 Electron 上）会带着 `ELECTRON_RUN_AS_NODE=1`，
 * 不清除时 electron.exe 会以纯 Node 方式运行，Playwright 报 “Process failed to launch!”。
 * scripts/lib/electronHarness.mjs 出于同一原因删除该变量。
 */
export function electronEnv() {
  const env = { ...process.env }
  const leaked = env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ATTACH_CONSOLE
  return { env, sanitized: { ELECTRON_RUN_AS_NODE: leaked ?? null } }
}

export async function waitForHttp(url, { attempts = 120, intervalMs = 500 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url)
      if (response.ok) return await response.json().catch(() => ({}))
    } catch {
      // 未就绪
    }
    await new Promise((done) => setTimeout(done, intervalMs))
  }
  throw new Error(`${url} 在 ${(attempts * intervalMs) / 1000}s 内未就绪`)
}

export function findFreePort(start = 9333) {
  for (let port = start; port < start + 50; port += 1) {
    const probe = spawnSync('node', ['-e', `require('net').createServer().listen(${port}).on('listening',function(){this.close()}).on('error',function(){process.exit(1)})`], { timeout: 5000 })
    if (probe.status === 0) return port
  }
  throw new Error('未找到可用端口')
}

/** 结束整棵进程树（Electron 会派生子进程），只针对本次探针启动的 pid */
export function killTree(pid) {
  if (!pid) return
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
}

export function nowIso() {
  return new Date().toISOString()
}
