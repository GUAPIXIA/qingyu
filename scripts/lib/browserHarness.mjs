// 浏览器联验公共设施：Vite 启动、Playwright 启动、就绪轮询与收尾。
// 各场景启动器只保留 mock 数据与断言；端口与输出目录由调用方传入。
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const require = createRequire(resolve('spatial-board/package.json'))
export const { chromium } = require('playwright')

/** 启动 517x 端口的 Vite（工作目录 = 仓库根），返回 { server, startupLog() } */
export function startViteServer({ port, host = '127.0.0.1', strictPort = true }) {
  const args = ['node_modules/vite/bin/vite.js', '--host', host, '--port', String(port)]
  if (strictPort) args.push('--strictPort')
  const server = spawn(process.execPath, args, { cwd: resolve('.'), stdio: 'pipe', windowsHide: true })
  let startup = ''
  server.stderr.on('data', (chunk) => { startup += chunk })
  server.stdout.on('data', (chunk) => { startup += chunk })
  return { server, startupLog: () => startup }
}

/** 启动无头 msedge（默认 1440×900），返回 { browser, page, errors } */
export async function launchHarnessBrowser({ width = 1440, height = 900 } = {}) {
  const browser = await chromium.launch({ headless: true, channel: 'msedge' })
  const page = await browser.newPage({ viewport: { width, height } })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  return { browser, page, errors }
}

/** 轮询等待 Vite 就绪（默认最多 80×100ms） */
export async function waitForServer(port, { attempts = 80, intervalMs = 100 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { if ((await fetch(`http://127.0.0.1:${port}`)).ok) return } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs))
  }
  throw new Error(`Vite 未在 ${attempts * intervalMs}ms 内就绪（port=${port}）`)
}

/**
 * 公共运行壳：启动 Vite 与浏览器 → 等待就绪 → 执行场景体 → 统一收尾。
 * run({ page, errors, server }) 内部自行写 result.json / 截图。
 */
export async function runBrowserSession({ port, viewport, run }) {
  const { server, startupLog } = startViteServer({ port })
  const { browser, page, errors } = await launchHarnessBrowser(viewport)
  try {
    await waitForServer(port)
    return await run({ page, errors, server })
  } catch (error) {
    console.error(startupLog().slice(-1800))
    console.error(errors)
    throw error
  } finally {
    await browser.close()
    server.kill()
  }
}