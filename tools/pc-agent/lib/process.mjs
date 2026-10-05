// 进程工具：只处理本工具自己启动的进程树。
import { spawnSync } from 'node:child_process'

/** 结束整棵进程树（Electron 会派生子进程）；只对本次工具启动的 pid 使用 */
export function killTree(pid) {
  if (!pid) return false
  const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  return result.status === 0
}

/** 进程是否存活（Windows 下 signal 0 同样适用） */
export function isAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}
