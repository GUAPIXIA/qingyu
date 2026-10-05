#!/usr/bin/env node
// 阶段 5 收尾：双入口全量矩阵回归（方案 §9 阶段 5 + §10「真实旅程必须同时从终端和 MCP 完成」）。
//
// 做法：分别用 CLI 与 MCP 两个真实入口，各起一个隔离会话，把全部旅程跑一遍，逐条比对结果。
// 输出：output/pc-agent/matrix-<时间戳>/ 下的 result.json 与 report.md（含逐旅程对照表）。
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRunDir, writeJson, writeText } from '../lib/evidence.mjs'
import { OUTPUT_ROOT, sanitizedEnv } from '../platform.mjs'
import { listSuites } from '../suites/index.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = resolve(HERE, '..', 'cli.mjs')
const MCP = resolve(HERE, '..', 'mcp-server.mjs')

/** 全部旅程所需的写权限（会话级白名单） */
const WRITE_MODULES = ['character', 'chat', 'group', 'lorebook', 'preset', 'persona', 'settings', 'usage', 'log', 'regex', 'quickReply', 'spatial', 'localModel', 'embedding']

async function main() {
const runDir = createRunDir(OUTPUT_ROOT, 'matrix')
const result = {
  verification: 'dual-entry-full-matrix',
  startedAt: new Date().toISOString(),
  runDir,
  suites: listSuites(),
  passes: {},
  errors: [],
}

function runCli(args, { timeoutMs = 1800000 } = {}) {
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
      let json = null
      try { json = JSON.parse(stdout) } catch { json = null }
      resolveRun({ code, stdout, stderr, json })
    })
  })
}

class McpClient {
  constructor(child) {
    this.child = child
    this.nextId = 1
    this.pending = new Map()
    this.buffer = ''
    this.stdoutLines = []
    this.stderr = ''
    child.stdout.on('data', (chunk) => {
      this.buffer += chunk.toString('utf8')
      let index = this.buffer.indexOf('\n')
      while (index >= 0) {
        const line = this.buffer.slice(0, index)
        this.buffer = this.buffer.slice(index + 1)
        if (line.trim()) {
          this.stdoutLines.push(line)
          try {
            const message = JSON.parse(line)
            if (message.id !== undefined && this.pending.has(message.id)) {
              const { resolve: done } = this.pending.get(message.id)
              this.pending.delete(message.id)
              done(message)
            }
          } catch { /* 由审计负责 */ }
        }
        index = this.buffer.indexOf('\n')
      }
    })
    child.stderr.on('data', (chunk) => { this.stderr += chunk.toString() })
  }

  request(method, params, { timeoutMs = 1800000 } = {}) {
    const id = this.nextId++
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`MCP 超时：${method}`)) }, timeoutMs)
      this.pending.set(id, {
        resolve: (message) => {
          clearTimeout(timer)
          if (message.error) reject(new Error(`${message.error.code}: ${message.error.message}`))
          else resolveRequest(message.result)
        },
      })
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  async callTool(name, args) {
    const response = await this.request('tools/call', { name, arguments: args })
    const text = response?.content?.find((item) => item.type === 'text')?.text ?? 'null'
    let parsed = null
    try { parsed = JSON.parse(text) } catch { parsed = { raw: text } }
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
    clientInfo: { name: 'pc-agent-matrix', version: '0.1.0' },
  })
  client.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`)
  return client
}

/** 分批大小：同一宿主内反复启动 Electron 有上限（约 20 次），因此每批前重启宿主 */
const CHUNK_SIZE = 5

function chunk(items, size) {
  const out = []
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size))
  return out
}

async function recycleHost() {
  await runCli(['host', 'stop'])
  await new Promise((done) => setTimeout(done, 1500))
}

async function runPassViaCli() {
  const suites = {}
  const sessions = []
  for (const [index, group] of chunk(listSuites(), CHUNK_SIZE).entries()) {
    await recycleHost()
    const started = await runCli(['session', 'start', '--profile', 'source-isolated',
      ...WRITE_MODULES.flatMap((module) => ['--allow-write', module]), '--label', `matrix-cli-${index + 1}`, '--json'])
    if (started.code !== 0 || !started.json?.session?.sessionId) {
      throw new Error(`CLI 会话启动失败（批 ${index + 1}）：${started.stderr.slice(0, 200) || started.stdout.slice(0, 200)}`)
    }
    const sessionId = started.json.session.sessionId
    sessions.push({ sessionId, runDir: started.json.runDir })
    for (const suite of group) {
      const outcome = await runCli(['suite', 'run', '--session', sessionId, '--suite', suite, '--json'])
      suites[suite] = {
        passed: outcome.json?.passed === true,
        steps: outcome.json?.steps?.length ?? 0,
        skipped: outcome.json?.skipped?.length ?? 0,
        exitCode: outcome.code,
        failedSteps: (outcome.json?.steps ?? []).filter((item) => !item.pass).map((item) => `${item.name} — ${item.detail}`),
        error: outcome.json ? null : outcome.stderr.slice(0, 200),
      }
      console.log(`  [CLI] ${suite}：${suites[suite].passed ? '通过' : '未通过'}（${suites[suite].steps} 步，跳过 ${suites[suite].skipped}）`)
    }
    await runCli(['session', 'close', '--session', sessionId, '--json'])
  }
  return { sessions, suites }
}

async function runPassViaMcp() {
  const mcp = await startMcp()
  try {
    const suites = {}
    const sessions = []
    for (const [index, group] of chunk(listSuites(), CHUNK_SIZE).entries()) {
      await recycleHost()
      const started = await mcp.callTool('qingyu_session', {
        action: 'start',
        profile: 'source-isolated',
        allowWriteModules: WRITE_MODULES,
        label: `matrix-mcp-${index + 1}`,
      })
      const sessionId = started.parsed?.session?.sessionId
      if (!sessionId) throw new Error(`MCP 会话启动失败（批 ${index + 1}）：${JSON.stringify(started.parsed)?.slice(0, 200)}`)
      sessions.push({ sessionId, runDir: started.parsed?.runDir })
      for (const suite of group) {
        const outcome = await mcp.callTool('qingyu_run_suite', { sessionId, suite })
        suites[suite] = {
          passed: outcome.parsed?.passed === true,
          steps: outcome.parsed?.steps?.length ?? 0,
          skipped: outcome.parsed?.skipped?.length ?? 0,
          failedSteps: (outcome.parsed?.steps ?? []).filter((item) => !item.pass).map((item) => `${item.name} — ${item.detail}`),
          error: outcome.isError ? JSON.stringify(outcome.parsed).slice(0, 200) : null,
        }
        console.log(`  [MCP] ${suite}：${suites[suite].passed ? '通过' : '未通过'}（${suites[suite].steps} 步，跳过 ${suites[suite].skipped}）`)
      }
      await mcp.callTool('qingyu_session', { action: 'close', sessionId })
    }
    return { sessions, suites, stdoutLines: mcp.stdoutLines.length }
  } finally {
    await mcp.close()
  }
}

try {
  console.log(`[双入口全量矩阵] run 目录：${runDir}`)
  console.log(`[双入口全量矩阵] 旅程 ${result.suites.length} 条`)
  console.log('--- CLI 入口 ---')
  result.passes.cli = await runPassViaCli()
  console.log('--- MCP 入口 ---')
  result.passes.mcp = await runPassViaMcp()
} catch (error) {
  result.errors.push(String(error?.stack ?? error))
  console.error('[双入口全量矩阵] 失败：', error)
}

// 逐条对照
const comparisons = result.suites.map((suite) => {
  const cli = result.passes.cli?.suites?.[suite] ?? null
  const mcp = result.passes.mcp?.suites?.[suite] ?? null
  return {
    suite,
    cli: cli?.passed ?? null,
    mcp: mcp?.passed ?? null,
    equivalent: Boolean(cli?.passed) === Boolean(mcp?.passed) && cli !== null && mcp !== null,
    cliSteps: cli?.steps ?? null,
    mcpSteps: mcp?.steps ?? null,
  }
})
result.comparisons = comparisons
result.finishedAt = new Date().toISOString()
result.passed = result.errors.length === 0 && comparisons.every((item) => item.equivalent && item.cli === true)

writeJson(resolve(runDir, 'result.json'), result)
const lines = [
  '# 双入口全量矩阵回归',
  '',
  `- 结果：${result.passed ? '✅ 通过' : '❌ 未通过'}`,
  `- run 目录：\`${runDir}\``,
  `- CLI 会话：${(result.passes.cli?.sessions ?? []).length} 个（每 ${CHUNK_SIZE} 条旅程一个会话，批间重启宿主）`,
  `- MCP 会话：${(result.passes.mcp?.sessions ?? []).length} 个（同上）`,
  '',
  '| 旅程 | CLI | MCP | 步数（CLI/MCP） | 等价 |',
  '|---|---|---|---|---|',
  ...comparisons.map((item) => `| ${item.suite} | ${item.cli === null ? '-' : item.cli ? '通过' : '未通过'} | ${item.mcp === null ? '-' : item.mcp ? '通过' : '未通过'} | ${item.cliSteps ?? '-'}/${item.mcpSteps ?? '-'} | ${item.equivalent ? '是' : '否'} |`),
]
if (result.errors.length) lines.push('', '## 错误', ...result.errors.map((error) => `\`\`\`\n${error}\n\`\`\``))
writeText(resolve(runDir, 'report.md'), `${lines.join('\n')}\n`)

console.log('')
console.log(`[双入口全量矩阵] ${result.passed ? '通过' : '未通过'}：${runDir}`)
process.exit(result.passed ? 0 : 1)
}

// 只在作为入口直接运行时执行；被 import（测试/工具）时不产生副作用
const isDirectRun = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isDirectRun) await main()

export { main as runMatrix }


