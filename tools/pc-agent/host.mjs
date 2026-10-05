#!/usr/bin/env node
// Session Host：持有 Playwright/Electron 句柄的常驻进程，经 Windows 本地命名管道对外提供服务。
// 由 CLI/MCP 通过 client.mjs 调用；同一会话内的写动作与生命周期操作由 Session 内部队列串行化。
//
// 用法（通常由 CLI 自动拉起，不需要手工执行）：
//   node tools/pc-agent/host.mjs --host-id <id> [--idle-timeout 60]
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runAssertionSpec, summarizeAssertions } from './lib/assertions.mjs'
import { createRunDir } from './lib/evidence.mjs'
import { isAlive, killTree } from './lib/process.mjs'
import { createLineDecoder, encodeMessage, pipePathFor } from './lib/protocol.mjs'
import { Session } from './lib/session.mjs'
import { OUTPUT_ROOT, REGISTRY_PATH, assertSupportedPlatform, buildIdentity } from './platform.mjs'
import { writeHostToken, removeHostToken } from './client.mjs'

/** 解析 --key value / --flag 形式的参数（模块级，入口与测试共用） */
function parseArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (!item.startsWith('--')) continue
    const key = item.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) parsed[key] = true
    else {
      parsed[key] = next
      index += 1
    }
  }
  return parsed
}

const args = parseArgs(process.argv.slice(2))
const hostId = args['host-id'] ?? `host-${Date.now().toString(36)}`

// 只在作为入口直接运行时启动宿主；被 import（测试/工具）时不产生副作用
const isDirectRun = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isDirectRun) await startHost()

async function startHost() {
const idleTimeoutMs = Number(args['idle-timeout'] ?? 60) * 1000
const token = randomBytes(24).toString('hex')
const pipePath = pipePathFor(hostId)
const debugPort = 9333 + Math.floor(Math.random() * 200)

assertSupportedPlatform()
mkdirSync(OUTPUT_ROOT, { recursive: true })

const host = {
  hostId,
  pid: process.pid,
  pipePath,
  token,
  debugPort,
  startedAt: new Date().toISOString(),
  sessions: new Map(),
  /** 连接级令牌集合：宿主令牌 + 各会话令牌 */
  validTokens: new Set([token]),
}

writeHostToken(hostId, token)

function readRegistry() {
  if (!existsSync(REGISTRY_PATH)) return { hosts: [], sessions: [] }
  try {
    const parsed = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'))
    return { hosts: parsed.hosts ?? [], sessions: parsed.sessions ?? [] }
  } catch {
    return { hosts: [], sessions: [] }
  }
}

/** 重写注册表；顺带清理 pid 已死的宿主（陈旧资源不静默复用） */
function writeRegistry() {
  const current = readRegistry()
  const hosts = current.hosts.filter((entry) => entry.hostId !== hostId && isAlive(entry.pid))
  hosts.push({
    hostId,
    pid: process.pid,
    pipe: pipePath,
    startedAt: host.startedAt,
    sessionCount: host.sessions.size,
  })
  const liveHostIds = new Set(hosts.map((entry) => entry.hostId))
  const sessions = current.sessions
    .filter((entry) => liveHostIds.has(entry.hostId) && entry.hostId !== hostId)
    .concat([...host.sessions.values()].map((session) => ({
      sessionId: session.id,
      hostId,
      runDir: session.runDir,
      profile: session.profile,
      state: session.state,
      startedAt: session.startedAt,
    })))
  mkdirSync(dirname(REGISTRY_PATH), { recursive: true })
  writeFileSync(REGISTRY_PATH, `${JSON.stringify({ hosts, sessions }, null, 2)}\n`, 'utf8')
}

/** 退出前把自己从注册表移除（否则会留下一条已死宿主记录） */
function removeSelfFromRegistry() {
  const current = readRegistry()
  const hosts = current.hosts.filter((entry) => entry.hostId !== hostId && isAlive(entry.pid))
  const liveHostIds = new Set(hosts.map((entry) => entry.hostId))
  const sessions = current.sessions.filter((entry) => liveHostIds.has(entry.hostId))
  mkdirSync(dirname(REGISTRY_PATH), { recursive: true })
  writeFileSync(REGISTRY_PATH, `${JSON.stringify({ hosts, sessions }, null, 2)}\n`, 'utf8')
}

function requireSession(sessionId) {
  const session = host.sessions.get(sessionId)
  if (!session) {
    const error = new Error(`未知会话：${sessionId}（当前宿主 ${hostId} 持有 ${host.sessions.size} 个会话）`)
    error.code = 'UNKNOWN_SESSION'
    throw error
  }
  return session
}

const methods = {
  ping: async () => ({ hostId, pid: process.pid, sessions: host.sessions.size, startedAt: host.startedAt }),

  doctor: async () => ({
    host: { hostId, pid: process.pid, pipe: pipePath },
    build: buildIdentity(),
    platform: process.platform,
  }),

  'session.start': async (params) => {
    const label = params.label ?? params.profile ?? 'session'
    const runDir = params.runDir ?? createRunDir(OUTPUT_ROOT, label)
    const session = new Session({
      host,
      runDir,
      profile: params.profile,
      allowedWriteModules: params.allowedWriteModules ?? [],
      allowStaleBuild: Boolean(params.allowStaleBuild),
      allowCredentialWrite: Boolean(params.allowCredentialWrite),
      label,
    })
    session.id = params.sessionId ?? `session-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
    // 先注册再启动：启动失败也能在注册表与 run 目录留下痕迹
    host.sessions.set(session.id, session)
    writeRegistry()
    try {
      const info = await session.start()
      writeRegistry()
      return { session: info, runDir }
    } catch (error) {
      await session.close({ reason: `start-failed: ${error.message}` }).catch(() => {})
      host.sessions.delete(session.id)
      writeRegistry()
      const wrapped = new Error(error.message)
      wrapped.code = error.code ?? 'SESSION_START_FAILED'
      throw wrapped
    }
  },

  'session.list': async () => ({ sessions: [...host.sessions.values()].map((session) => session.publicInfo()) }),

  'session.get': async ({ sessionId }) => ({ session: requireSession(sessionId).publicInfo() }),

  'session.restart': async ({ sessionId }) => {
    const session = requireSession(sessionId)
    const info = await session.restart()
    writeRegistry()
    return { session: info }
  },

  'session.close': async ({ sessionId, reason }) => {
    const session = requireSession(sessionId)
    const summary = await session.close({ reason: reason ?? 'cli' })
    host.sessions.delete(sessionId)
    writeRegistry()
    return { summary }
  },

  invoke: async ({ sessionId, action, args, wait }) => requireSession(sessionId).invoke(action, args ?? [], { wait: wait !== false }),

  observe: async ({ sessionId, action, args }) => requireSession(sessionId).observe(action, args ?? []),

  assert: async ({ sessionId, specs }) => {
    const session = requireSession(sessionId)
    const records = []
    for (const spec of specs ?? []) {
      const record = await runAssertionSpec(spec, {
        sessionId,
        invokeAction: (action, callArgs) => session.invoke(action, callArgs, { purpose: 'assert', allowWrite: false }),
      })
      session.recordAssertion(record)
      records.push(record)
    }
    return { records, summary: summarizeAssertions(records) }
  },

  evidence: async ({ sessionId }) => {
    const session = requireSession(sessionId)
    return {
      session: session.publicInfo(),
      runDir: session.runDir,
      actions: session.evidence.readActions(),
      assertions: session.evidence.readAssertions(),
      summary: summarizeAssertions(session.assertionRecords),
    }
  },

  screenshot: async ({ sessionId, name }) => {
    const session = requireSession(sessionId)
    return { path: await session.screenshot(name ?? `shot-${Date.now()}.png`) }
  },

  'host.stop': async () => {
    setTimeout(() => shutdown('requested'), 50)
    return { stopping: true, hostId }
  },
}

const server = createServer((socket) => {
  let authenticated = false
  const reply = (payload) => {
    if (!socket.destroyed) socket.write(encodeMessage(payload))
  }

  socket.on('data', createLineDecoder(async (message) => {
    if (message.method === 'auth') {
      if (!host.validTokens.has(message.params?.token)) {
        reply({ id: message.id, ok: false, error: { code: 'UNAUTHORIZED', message: '令牌不匹配' } })
        socket.destroy()
        return
      }
      authenticated = true
      reply({ id: message.id, ok: true, result: { hostId, pid: process.pid } })
      return
    }
    if (!authenticated) {
      reply({ id: message.id, ok: false, error: { code: 'UNAUTHORIZED', message: '未通过令牌校验' } })
      return
    }

    const handler = methods[message.method]
    if (!handler) {
      reply({ id: message.id, ok: false, error: { code: 'UNKNOWN_METHOD', message: `未知方法：${message.method}` } })
      return
    }
    try {
      const result = await handler(message.params ?? {})
      reply({ id: message.id, ok: true, result })
      writeRegistry()
    } catch (error) {
      reply({
        id: message.id,
        ok: false,
        error: {
          code: error.code ?? 'HOST_ERROR',
          message: String(error.message),
          stack: error.stack?.split('\n').slice(0, 3).join(' | '),
        },
      })
    }
  }, (line) => reply({ id: null, ok: false, error: { code: 'BAD_MESSAGE', message: `无法解析的消息：${line.slice(0, 80)}` } })))
})

server.listen(pipePath, () => {
  writeRegistry()
  process.stdout.write(`${JSON.stringify({ ready: true, hostId, pid: process.pid, pipe: pipePath })}\n`)
})

let lastActivity = Date.now()
const idleTimer = setInterval(() => {
  if (host.sessions.size > 0) {
    lastActivity = Date.now()
    return
  }
  if (Date.now() - lastActivity > idleTimeoutMs) shutdown('idle-timeout')
}, 5000)
idleTimer.unref?.()

async function shutdown(reason) {
  clearInterval(idleTimer)
  for (const session of host.sessions.values()) {
    await session.close({ reason: `host-shutdown: ${reason}` }).catch(() => {})
  }
  host.sessions.clear()
  removeSelfFromRegistry()
  removeHostToken(hostId)
  server.close()
  process.exit(0)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

/** 未捕获异常/拒绝必须落盘：宿主静默退出会让上层只能看到 HOST_GONE */
process.on('uncaughtException', (error) => {
  process.stderr.write(`[host] uncaughtException: ${error?.stack ?? error}\n`)
  shutdown('uncaughtException')
})
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`[host] unhandledRejection: ${reason?.stack ?? reason}\n`)
})

process.on('exit', () => {
  for (const session of host.sessions.values()) {
    if (session.packagedChild?.pid) killTree(session.packagedChild.pid)
  }
})
}

export { startHost }




