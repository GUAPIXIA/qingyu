// CLI / MCP 侧的宿主客户端：按需拉起 Session Host，解析会话，发起请求。
//
// 令牌模型（阶段 1）：
//  - 宿主令牌：`output/pc-agent/runtime/hosts/<hostId>.token`（0600），用于宿主级请求（doctor / session start / session list）；
//  - 会话令牌：`<runDir>/runtime/token`（0600），用于针对该会话的请求（invoke / observe / assert / restart / close）。
// 连接时校验令牌；按会话的写入授权由会话的动作白名单在宿主侧强制（见 lib/actions.mjs checkPermission）。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JsonChannel, connectPipe, pipePathFor } from './lib/protocol.mjs'
import { isAlive } from './lib/process.mjs'
import { OUTPUT_ROOT, REGISTRY_PATH } from './platform.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

export const HOST_TOKEN_DIR = resolve(OUTPUT_ROOT, 'hosts')

export function readRegistry() {
  if (!existsSync(REGISTRY_PATH)) return { hosts: [], sessions: [] }
  try {
    const parsed = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'))
    return { hosts: parsed.hosts ?? [], sessions: parsed.sessions ?? [] }
  } catch {
    return { hosts: [], sessions: [] }
  }
}

export function liveHosts() {
  return readRegistry().hosts.filter((entry) => isAlive(entry.pid))
}

/** 解析会话 → { sessionId, hostId, runDir, profile, host } */
export function resolveSession(sessionId) {
  const registry = readRegistry()
  // 注册表可能被并发写（例如旧宿主退出时按陈旧快照重写），因此磁盘上的 session.json 作为兜底来源
  const entry = registry.sessions.find((item) => item.sessionId === sessionId) ?? findSessionOnDisk(sessionId)
  if (!entry) {
    const error = new Error(`未知会话：${sessionId}（可先用 pc-agent session list 查看）`)
    error.code = 'UNKNOWN_SESSION'
    throw error
  }
  const host = registry.hosts.find((item) => item.hostId === entry.hostId)
  if (!host || !isAlive(host.pid)) {
    const error = new Error(`会话 ${sessionId} 所属宿主已退出（hostId=${entry.hostId}）。进程中断且无法证明提交结果时，应先读回核对再决定是否重发。`)
    error.code = 'HOST_GONE'
    throw error
  }
  return { ...entry, host }
}

/** 扫描 run 目录，从 session.json 还原会话条目（注册表竞写/丢失时的兜底） */
function findSessionOnDisk(sessionId) {
  if (!existsSync(OUTPUT_ROOT)) return null
  for (const item of readdirSync(OUTPUT_ROOT, { withFileTypes: true })) {
    if (!item.isDirectory()) continue
    const runDir = resolve(OUTPUT_ROOT, item.name)
    const sessionFile = resolve(runDir, 'session.json')
    if (!existsSync(sessionFile)) continue
    try {
      const info = JSON.parse(readFileSync(sessionFile, 'utf8'))
      if (info.sessionId !== sessionId) continue
      return {
        sessionId,
        hostId: info.host?.hostId ?? null,
        runDir,
        profile: info.profile ?? null,
        state: info.state ?? null,
        startedAt: info.startedAt ?? null,
      }
    } catch {
      // 忽略损坏的会话文件
    }
  }
  return null
}

export function hostTokenPath(hostId) {
  return resolve(HOST_TOKEN_DIR, `${hostId}.token`)
}

function readFileToken(path) {
  if (!existsSync(path)) {
    const error = new Error(`缺少令牌文件：${path}`)
    error.code = 'TOKEN_MISSING'
    throw error
  }
  return readFileSync(path, 'utf8').trim()
}

export function sessionToken(runDir) {
  return readFileToken(resolve(runDir, 'runtime', 'token'))
}

async function openChannel({ pipe, hostId }, token, { timeoutMs = 10000 } = {}) {
  const socket = await connectPipe(pipe ?? pipePathFor(hostId), { timeoutMs })
  const channel = new JsonChannel(socket)
  await channel.request('auth', { token }, { timeoutMs })
  return channel
}

/** 确保存在一个可用宿主；没有就拉起一个（脱离父进程，CLI 退出后仍持有会话） */
export async function ensureHost({ idleTimeoutSec = 60 } = {}) {
  pruneStaleHostTokens()
  pruneRegistry()
  const existing = liveHosts()
  if (existing.length > 0) return existing[0]

  const hostId = `host-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  // 宿主日志落盘：崩溃必须可诊断，不能静默消失
  const hostLogPath = resolve(OUTPUT_ROOT, 'logs', `host-${hostId}.log`)
  mkdirSync(dirname(hostLogPath), { recursive: true })
  const hostLog = openSync(hostLogPath, 'a')
  const child = spawn(process.execPath, [
    resolve(HERE, 'host.mjs'),
    '--host-id', hostId,
    '--idle-timeout', String(idleTimeoutSec),
  ], { cwd: HERE, detached: true, stdio: ['ignore', hostLog, hostLog], windowsHide: true })
  child.unref()

  const pipePath = pipePathFor(hostId)
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    try {
      const socket = await connectPipe(pipePath, { timeoutMs: 1000 })
      socket.destroy()
      return { hostId, pid: child.pid, pipe: pipePath, startedAt: new Date().toISOString(), sessionCount: 0 }
    } catch {
      await new Promise((done) => setTimeout(done, 300))
    }
  }
  const error = new Error('Session Host 未在 15s 内就绪')
  error.code = 'HOST_START_FAILED'
  throw error
}

export class AgentClient {
  constructor({ channel, sessionId = null, runDir = null, host = null }) {
    this.channel = channel
    this.sessionId = sessionId
    this.runDir = runDir
    this.host = host
  }

  /** 宿主级客户端：可做 doctor / session start / session list */
  static async forHost() {
    const host = await ensureHost()
    const channel = await openChannel(host, readFileToken(hostTokenPath(host.hostId)))
    return new AgentClient({ channel, host })
  }

  /** 会话级客户端：invoke / observe / assert / restart / close / evidence */
  static async forSession(sessionId) {
    const entry = resolveSession(sessionId)
    const channel = await openChannel(entry.host, sessionToken(entry.runDir))
    return new AgentClient({ channel, sessionId, runDir: entry.runDir, host: entry.host })
  }

  request(method, params = {}, options) {
    const payload = this.sessionId ? { sessionId: this.sessionId, ...params } : { ...params }
    return this.channel.request(method, payload, options)
  }

  close() {
    this.channel?.close()
  }
}

/** 宿主启动时写入自己的令牌文件（0600），供本机 CLI/MCP 读取 */
export function writeHostToken(hostId, token) {
  mkdirSync(HOST_TOKEN_DIR, { recursive: true })
  const path = hostTokenPath(hostId)
  writeFileSync(path, token, { encoding: 'utf8', mode: 0o600 })
  return path
}

export function removeHostToken(hostId) {
  const path = hostTokenPath(hostId)
  if (existsSync(path)) unlinkSync(path)
}

/** 清理注册表中已死宿主及其会话（宿主被强杀时不会执行自身清理，这里兜底） */
export function pruneRegistry() {
  const registry = readRegistry()
  const hosts = registry.hosts.filter((entry) => isAlive(entry.pid))
  const liveHostIds = new Set(hosts.map((entry) => entry.hostId))
  const sessions = registry.sessions.filter((entry) => liveHostIds.has(entry.hostId))
  const changed = hosts.length !== registry.hosts.length || sessions.length !== registry.sessions.length
  if (changed) {
    mkdirSync(dirname(REGISTRY_PATH), { recursive: true })
    writeFileSync(REGISTRY_PATH, `${JSON.stringify({ hosts, sessions }, null, 2)}\n`, 'utf8')
  }
  return changed
}

/** 清理已死宿主的令牌文件；只处理本目录下的 *.token，且路径必须落在本目录内 */export function pruneStaleHostTokens() {
  if (!existsSync(HOST_TOKEN_DIR)) return []
  const liveIds = new Set(liveHosts().map((host) => host.hostId))
  const removed = []
  for (const name of readdirSync(HOST_TOKEN_DIR)) {
    if (!name.endsWith('.token')) continue
    const hostId = name.slice(0, -'.token'.length)
    if (liveIds.has(hostId)) continue
    const path = resolve(HOST_TOKEN_DIR, name)
    if (!path.startsWith(resolve(HOST_TOKEN_DIR) + sep)) continue
    unlinkSync(path)
    removed.push(name)
  }
  return removed
}
