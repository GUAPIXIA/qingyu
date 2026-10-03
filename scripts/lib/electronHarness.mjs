// Electron 联验公共设施：esbuild 打包（external electron）、真实 Electron 子进程启动、
// 日志文件句柄继承与退出码收集。各启动器只保留入口/参数与断言，统一 bundle/日志/退出处理。
import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { build } from 'esbuild'

/** 仓库内 Electron 可执行文件（与主仓开发入口一致） */
export const ELECTRON_EXE = resolve('node_modules/electron/dist/electron.exe')

/**
 * 打包为可由 Electron 直接运行的 CJS bundle（electron 外置，运行时提供）。
 * 支持 entryPoints（脚本/基准）或 stdin（内联探针）两种入口。
 */
export async function buildElectronBundle({ entry, outfile, target = 'node18', stdin }) {
  mkdirSync(dirname(outfile), { recursive: true })
  await build({
    ...(stdin ? { stdin } : { entryPoints: [entry] }),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target,
    external: ['electron'],
    outfile,
  })
  return outfile
}

/**
 * 启动 Electron 运行 bundle。
 * - stdio='log'（默认）：把子进程 stdout/stderr 直接写入 logFile（父 shell 退出也不留断开管道）。
 * - stdio='pipe'：返回的 child 暴露可读流（调用方可自行 destroy）。
 * 返回 { child, exited }，exited 解析为退出码，可选 timeoutMs。
 */
export function spawnElectronBundle({ bundle, args = [], logFile, stdio = 'log', timeoutMs, cwd = process.cwd() }) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  let fd
  let childStdio
  if (stdio === 'log') {
    mkdirSync(dirname(logFile), { recursive: true })
    fd = openSync(logFile, 'a')
    childStdio = ['ignore', fd, fd]
  } else {
    childStdio = stdio
  }
  let child
  try {
    child = spawn(ELECTRON_EXE, [bundle, ...args], { cwd, env, stdio: childStdio, windowsHide: true })
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
  const exited = new Promise((resolveExit, reject) => {
    const timer = timeoutMs ? setTimeout(() => { child.kill(); reject(new Error('Electron 子进程超时')) }, timeoutMs) : null
    child.once('error', (error) => { if (timer) clearTimeout(timer); reject(error) })
    child.once('exit', (code) => { if (timer) clearTimeout(timer); resolveExit(code ?? 1) })
  })
  return { child, exited }
}

/** 打包并运行，返回退出码（非 0 由调用方判定失败）。 */
export async function runElectronBundle({ entry, outfile, args = [], logFile, target, stdio = 'log', timeoutMs, cwd }) {
  await buildElectronBundle({ entry, outfile, target })
  const { exited } = spawnElectronBundle({ bundle: outfile, args, logFile, stdio, timeoutMs, cwd })
  return exited
}

/** 便捷：输出目录下的相对路径（统一 output/<name>/<file>） */
export function outputPath(name, file) {
  return resolve(join('output', name, file))
}
