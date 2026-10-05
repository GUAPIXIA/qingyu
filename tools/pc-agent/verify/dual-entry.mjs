#!/usr/bin/env node
// 阶段 2 验证：同一动作经 CLI 与 MCP 得到等价结果（方案 §9 阶段 2 退出条件）。
// 两个入口都是真实进程：CLI = cli.mjs --json；MCP = mcp-server.mjs（stdio JSON-RPC）。
// 额外验证：MCP stdout 纯净（只含 JSON-RPC、不含令牌）、跨入口共享同一宿主与动作目录。
//
// 用法：node tools/pc-agent/verify/dual-entry.mjs
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRunDir, writeJson, writeText } from '../lib/evidence.mjs'
import { compareOutcomes, isJsonRpcLine } from '../lib/equivalence.mjs'
import { OUTPUT_ROOT, sanitizedEnv } from '../platform.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = resolve(HERE, '..', 'cli.mjs')
const MCP = resolve(HERE, '..', 'mcp-server.mjs')

const runDir = createRunDir(OUTPUT_ROOT, 'dual-entry')
const result = {
  verification: 'dual-entry-equivalence',
  startedAt: new Date().toISOString(),
  runDir,
  steps: [],
  comparisons: [],
  stdoutAudit: null,
  errors: [],
}

function record(name, pass, detail) {
  result.steps.push({ name, pass: Boolean(pass), detail })
  console.log(` ${pass ? '✓' : '✗'} ${name}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
  return Boolean(pass)
}

// ---------- CLI 入口 ----------
function runCli(args, { timeoutMs = 300000 } = {}) {
  return new Promise((resolveRun) => {
    const { env } = sanitizedEnv()
    const child = spawn(process.execPath, [CLI, ...args], { env, windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (code) => {
      clearTimeout(timer)
      let parsed = null
      try {
        parsed = JSON.parse(stdout)
      } catch {
        parsed = null
      }
      resolveRun({ code, stdout, stderr, json: parsed })
    })
  })
}

// ---------- MCP 入口 ----------
class McpClient {
  constructor(child) {
    this.child = child
    this.nextId = 1
    this.pending = new Map()
    this.rawLines = []
    this.stderr = ''
    this.buffer = ''
    child.stdout.on('data', (chunk) => {
      this.buffer += chunk.toString('utf8')
      let index = this.buffer.indexOf('\n')
      while (index >= 0) {
        const line = this.buffer.slice(0, index)
        this.buffer = this.buffer.slice(index + 1)
        if (line.trim()) {
          this.rawLines.push(line)
          try {
            const message = JSON.parse(line)
            if (message.id !== undefined && this.pending.has(message.id)) {
              const { resolve: done } = this.pending.get(message.id)
              this.pending.delete(message.id)
              done(message)
            }
          } catch {
            // 非 JSON 行由 stdout 审计负责报告
          }
        }
        index = this.buffer.indexOf('\n')
      }
    })
    child.stderr.on('data', (chunk) => { this.stderr += chunk.toString('utf8') })
  }

  send(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  request(method, params, { timeoutMs = 300000 } = {}) {
    const id = this.nextId++
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP 请求超时：${method}`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (message) => {
          clearTimeout(timer)
          if (message.error) reject(new Error(`${message.error.code}: ${message.error.message}`))
          else resolveRequest(message.result)
        },
      })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method, params) {
    this.send({ jsonrpc: '2.0', method, params })
  }

  async callTool(name, args) {
    const response = await this.request('tools/call', { name, arguments: args })
    const text = response?.content?.find((item) => item.type === 'text')?.text ?? 'null'
    let parsed = null
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = { raw: text }
    }
    return { parsed, isError: Boolean(response?.isError) }
  }

  async close() {
    this.child.stdin.end()
    await new Promise((done) => {
      const timer = setTimeout(() => { this.child.kill(); done() }, 3000)
      this.child.once('close', () => { clearTimeout(timer); done() })
    })
  }
}

async function startMcp() {
  const { env } = sanitizedEnv()
  const child = spawn(process.execPath, [MCP], { env, windowsHide: true })
  const client = new McpClient(child)
  await client.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'pc-agent-dual-entry-verify', version: '0.1.0' },
  })
  client.notify('notifications/initialized', {})
  return client
}

// ---------- 主流程 ----------
let mcp = null
let sessionId = null
try {
  console.log(`[双入口验证] run 目录：${runDir}`)

  const doctor = await runCli(['doctor', '--json'])
  record('CLI doctor 可用', doctor.code === 0 && Boolean(doctor.json?.build), doctor.json?.build?.gitCommit ?? `exit=${doctor.code}`)

  mcp = await startMcp()
  const tools = await mcp.request('tools/list', {})
  const toolNames = (tools?.tools ?? []).map((tool) => tool.name)
  const expectedTools = ['qingyu_doctor', 'qingyu_capabilities', 'qingyu_session', 'qingyu_call', 'qingyu_observe', 'qingyu_operation', 'qingyu_assert', 'qingyu_run_suite', 'qingyu_evidence']
  record('MCP 暴露 9 个基础工具', expectedTools.every((name) => toolNames.includes(name)), toolNames.join(', '))

  const mcpDoctor = await mcp.callTool('qingyu_doctor', {})
  record('MCP qingyu_doctor 返回构建身份', Boolean(mcpDoctor.parsed?.build?.gitCommit), mcpDoctor.parsed?.build?.gitCommit)

  // 通过 MCP 启动会话（证明 MCP 与 CLI 共用同一宿主）
  const started = await mcp.callTool('qingyu_session', {
    action: 'start',
    profile: 'source-isolated',
    allowWriteModules: ['character', 'chat'],
    label: 'dual-entry',
  })
  sessionId = started.parsed?.session?.sessionId ?? null
  record('MCP 启动会话成功', Boolean(sessionId), sessionId ?? JSON.stringify(started.parsed).slice(0, 160))

  const cliSessions = await runCli(['session', 'list', '--json'])
  record('CLI 能看到 MCP 启动的会话（共享宿主）',
    (cliSessions.json?.sessions ?? []).some((entry) => entry.sessionId === sessionId),
    (cliSessions.json?.sessions ?? []).map((entry) => entry.sessionId).join(', '))

  // 用 CLI 建测试角色，再用两个入口读回（跨入口共享状态）
  const stamp = Date.now().toString(36)
  const characterId = `qa-dual-${stamp}`
  const characterName = `QA-双入口-${stamp}`
  const now = Date.now()
  const argsFile = resolve(runDir, 'character-args.json')
  writeJson(argsFile, [{
    id: characterId,
    name: characterName,
    avatar: '',
    description: '阶段 2 双入口验证角色（隔离档案）',
    personality: '简短',
    scenario: '双入口验证',
    firstMessage: '你好。',
    exampleDialog: '',
    tags: ['qa', 'dual-entry'],
    lorebookId: null,
    creator: 'pc-agent',
    createdAt: now,
    updatedAt: now,
    alternateGreetings: [],
  }])

  const saved = await runCli(['invoke', '--session', sessionId, '--action', 'character.save', '--args-file', argsFile, '--json'])
  record('CLI 写入测试角色', saved.code === 0 && saved.json?.status === 'succeeded', saved.json?.status ?? saved.stderr.slice(0, 120))

  // 会话（供 getStats 比较）
  const created = await mcp.callTool('qingyu_call', {
    sessionId,
    action: 'chat.createSession',
    args: [characterId, `QA-双入口会话-${stamp}`],
  })
  const createdSessionId = created.parsed?.result?.id ?? null
  record('MCP 创建会话成功', Boolean(createdSessionId), createdSessionId ?? JSON.stringify(created.parsed).slice(0, 160))

  // 同一动作，两个入口，逐个比较
  const cases = [
    { action: 'app.getVersion', args: [] },
    { action: 'character.list', args: [] },
    { action: 'character.get', args: [characterId] },
    { action: 'chat.listSessions', args: [characterId] },
    { action: 'chat.getStats', args: [characterId, createdSessionId] },
  ]

  for (const item of cases) {
    const argsFileForCase = resolve(runDir, `args-${item.action.replace(/\./g, '-')}.json`)
    writeJson(argsFileForCase, item.args)
    const cliOutcome = await runCli(['invoke', '--session', sessionId, '--action', item.action, '--args-file', argsFileForCase, '--json'])
    const mcpOutcome = await mcp.callTool('qingyu_call', { sessionId, action: item.action, args: item.args })
    const comparison = compareOutcomes(cliOutcome.json, mcpOutcome.parsed)
    result.comparisons.push({ action: item.action, args: item.args, ...comparison, cliStatus: cliOutcome.json?.status, mcpStatus: mcpOutcome.parsed?.status })
    record(`${item.action}：CLI 与 MCP 结果等价`, comparison.equivalent,
      comparison.equivalent ? `status=${cliOutcome.json?.status}` : JSON.stringify(comparison.differences))
  }

  // 只读入口等价（observe）
  const observeArgsFile = resolve(runDir, 'args-observe.json')
  writeJson(observeArgsFile, [characterId])
  const cliObserve = await runCli(['observe', '--session', sessionId, '--action', 'character.get', '--args-file', observeArgsFile, '--json'])
  const mcpObserve = await mcp.callTool('qingyu_observe', { sessionId, action: 'character.get', args: [characterId] })
  const observeComparison = compareOutcomes(cliObserve.json, mcpObserve.parsed)
  result.comparisons.push({ action: 'observe:character.get', ...observeComparison })
  record('observe 入口等价', observeComparison.equivalent, JSON.stringify(observeComparison.differences))

  // 断言与证据入口
  const specsPath = resolve(runDir, 'specs.json')
  const specs = [
    { name: '角色名一致', action: 'character.get', args: [characterId], path: 'name', op: 'equals', expected: characterName },
  ]
  writeJson(specsPath, specs)
  const cliAssert = await runCli(['assert', '--session', sessionId, '--spec-file', specsPath, '--json'])
  const mcpAssert = await mcp.callTool('qingyu_assert', { sessionId, specs })
  record('断言入口等价且确实通过',
    cliAssert.json?.summary?.passed === 1 && mcpAssert.parsed?.summary?.passed === 1 &&
    JSON.stringify(cliAssert.json?.records?.map((r) => [r.name, r.pass, r.actual])) === JSON.stringify(mcpAssert.parsed?.records?.map((r) => [r.name, r.pass, r.actual])),
    `cli=${JSON.stringify(cliAssert.json?.summary)} mcp=${JSON.stringify(mcpAssert.parsed?.summary)}`)

  const cliEvidence = await runCli(['evidence', '--session', sessionId, '--json'])
  const mcpEvidence = await mcp.callTool('qingyu_evidence', { sessionId })
  record('证据入口等价（同一 run 目录与动作条数）',
    cliEvidence.json?.runDir === mcpEvidence.parsed?.runDir &&
    (cliEvidence.json?.actions?.length ?? -1) === (mcpEvidence.parsed?.actions?.length ?? -2),
    `cli=${cliEvidence.json?.actions?.length} mcp=${mcpEvidence.parsed?.actions?.length}`)

  // 未知工具与错误传播
  const unknownTool = await mcp.callTool('qingyu_nope', {})
  record('未知工具返回错误而不是崩溃', unknownTool.isError && unknownTool.parsed?.error?.code === 'UNKNOWN_TOOL', unknownTool.parsed?.error?.code)

  const unknownAction = await mcp.callTool('qingyu_call', { sessionId, action: 'chat.doesNotExist', args: [] })
  record('MCP 未知动作按协议返回 rejected（与 CLI 一致）', unknownAction.parsed?.status === 'rejected' && unknownAction.parsed?.error?.code === 'UNKNOWN_ACTION', unknownAction.parsed?.error?.code)

  // 越权：另起一个未授权写模块的会话，再用 MCP 尝试写动作
  const readOnly = await mcp.callTool('qingyu_session', { action: 'start', profile: 'source-isolated', label: 'dual-entry-readonly' })
  const readOnlySessionId = readOnly.parsed?.session?.sessionId ?? null
  if (readOnlySessionId) {
    const unauthorized = await mcp.callTool('qingyu_call', { sessionId: readOnlySessionId, action: 'character.save', args: [{}] })
    record('MCP 写动作越权被拒（blocked / NOT_AUTHORIZED）',
      unauthorized.parsed?.status === 'blocked' && unauthorized.parsed?.error?.code === 'NOT_AUTHORIZED',
      `${unauthorized.parsed?.status} / ${unauthorized.parsed?.error?.code}`)
    await mcp.callTool('qingyu_session', { action: 'close', sessionId: readOnlySessionId })
  } else {
    record('MCP 写动作越权被拒（blocked / NOT_AUTHORIZED）', false, '未能启动只读会话')
  }

  // stdout 纯净性审计
  const badLines = mcp.rawLines.filter((line) => !isJsonRpcLine(line))
  const tokens = collectTokens()
  const leaked = tokens.filter((token) => mcp.rawLines.some((line) => line.includes(token)) || mcp.stderr.includes(token))
  result.stdoutAudit = { lines: mcp.rawLines.length, badLines: badLines.length, tokensChecked: tokens.length, leaked }
  record('MCP stdout 只含 JSON-RPC 消息', badLines.length === 0, `共 ${mcp.rawLines.length} 行，非法 ${badLines.length} 行`)
  record('MCP stdout/stderr 不泄漏令牌', leaked.length === 0, leaked.length ? `${leaked.length} 处泄漏` : `已检查 ${tokens.length} 个令牌`)
  record('MCP 日志走 stderr', mcp.stderr.includes('[qingyu-pc-agent]'), mcp.stderr.split('\n')[0]?.slice(0, 100) ?? '（空）')

  // 同一套 suite 经 MCP 运行（CLI 侧已在阶段 1 报告验证；此处完成“双入口旅程”的另一半）
  const suiteResult = await mcp.callTool('qingyu_run_suite', { sessionId, suite: 'chat.basic' })
  record('MCP 运行 chat.basic 纵切闭环通过',
    suiteResult.parsed?.passed === true && (suiteResult.parsed?.steps ?? []).every((step) => step.pass),
    `steps=${(suiteResult.parsed?.steps ?? []).filter((step) => step.pass).length}/${(suiteResult.parsed?.steps ?? []).length} runDir=${suiteResult.parsed?.runDir ?? '-'}`)
} catch (error) {
  result.errors.push(String(error?.stack ?? error))
  console.error('[双入口验证] 失败：', error)
} finally {
  if (sessionId) {
    const closed = await runCli(['session', 'close', '--session', sessionId, '--json'])
    record('会话已关闭', closed.code === 0, closed.json?.summary?.reason ?? `exit=${closed.code}`)
  }
  if (mcp) await mcp.close()
}

function collectTokens() {
  const tokens = []
  try {
    const registry = JSON.parse(readFileSync(resolve(OUTPUT_ROOT, 'registry.json'), 'utf8'))
    for (const host of registry.hosts ?? []) {
      const path = resolve(OUTPUT_ROOT, 'hosts', `${host.hostId}.token`)
      if (existsSync(path)) tokens.push(readFileSync(path, 'utf8').trim())
    }
    for (const session of registry.sessions ?? []) {
      const path = resolve(session.runDir, 'runtime', 'token')
      if (existsSync(path)) tokens.push(readFileSync(path, 'utf8').trim())
    }
  } catch {
    // 注册表缺失时没有可审计令牌
  }
  return [...new Set(tokens.filter(Boolean))]
}

result.finishedAt = new Date().toISOString()
result.passed = result.steps.every((step) => step.pass) && result.errors.length === 0
writeJson(resolve(runDir, 'result.json'), result)

const lines = [
  '# 阶段 2 验证：CLI 与 MCP 双入口等价',
  '',
  `- 结果：${result.passed ? '✅ 通过' : '❌ 未通过'}`,
  `- run 目录：\`${runDir}\``,
  '',
  '| 步骤 | 结果 | 说明 |',
  '|---|---|---|',
  ...result.steps.map((step) => `| ${step.name} | ${step.pass ? '通过' : '未通过'} | ${String(step.detail ?? '-').replace(/\|/g, '\\|')} |`),
  '',
  '## 动作级比较',
  '',
  '| 动作 | 等价 | CLI 状态 | MCP 状态 | 差异 |',
  '|---|---|---|---|---|',
  ...result.comparisons.map((item) => `| ${item.action} | ${item.equivalent ? '是' : '否'} | ${item.cliStatus ?? '-'} | ${item.mcpStatus ?? '-'} | ${item.equivalent ? '-' : JSON.stringify(item.differences)} |`),
  '',
  '## stdout 审计',
  '',
  `- MCP stdout 行数：${result.stdoutAudit?.lines ?? '-'}（非法 ${result.stdoutAudit?.badLines ?? '-'}）`,
  `- 令牌检查：${result.stdoutAudit?.tokensChecked ?? 0} 个，泄漏 ${result.stdoutAudit?.leaked?.length ?? 0} 处`,
]
if (result.errors.length) lines.push('', '## 错误', ...result.errors.map((error) => `\`\`\`\n${error}\n\`\`\``))
writeText(resolve(runDir, 'report.md'), `${lines.join('\n')}\n`)

console.log('')
console.log(`[双入口验证] ${result.passed ? '通过' : '未通过'}：${runDir}`)
process.exit(result.passed ? 0 : 1)
