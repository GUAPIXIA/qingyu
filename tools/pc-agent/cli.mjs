#!/usr/bin/env node
// pc-agent CLI：外部 Agent 的终端入口。机器模式下 stdout 只输出完整 JSON，日志走 stderr。
// 退出码（方案 §5.4）：0 协议成功；1 动作或断言失败；2 参数/协议错误；3 环境阻塞/不支持；4 需要用户交互。
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { AgentClient, liveHosts } from './client.mjs'
import { createRunDir } from './lib/evidence.mjs'
import { OUTPUT_ROOT, PROFILES, buildIdentity } from './platform.mjs'

const EXIT = { OK: 0, FAILED: 1, PROTOCOL: 2, BLOCKED: 3, INTERACTION: 4 }

function parseArgv(argv) {
  const positionals = []
  const flags = {}
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (item.startsWith('--')) {
      const key = item.slice(2)
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true
      } else if (flags[key] === undefined) {
        flags[key] = next
        index += 1
      } else {
        flags[key] = Array.isArray(flags[key]) ? [...flags[key], next] : [flags[key], next]
        index += 1
      }
    } else {
      positionals.push(item)
    }
  }
  return { positionals, flags }
}

function readJsonFile(path, label) {
  try {
    return JSON.parse(readFileSync(resolve(path), 'utf8'))
  } catch (error) {
    const wrapped = new Error(`无法读取${label}：${path}（${error.message}）`)
    wrapped.code = 'BAD_FILE'
    throw wrapped
  }
}

function out(value, { json }) {
  if (json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
    return
  }
  process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`)
}

function log(message) {
  process.stderr.write(`${message}\n`)
}

function exitCodeFor(outcome) {
  if (!outcome) return EXIT.OK
  const status = outcome.status
  if (status === 'succeeded' || status === 'accepted' || status === 'running') return EXIT.OK
  if (status === 'blocked') return EXIT.BLOCKED
  if (status === 'needs_interaction') return EXIT.INTERACTION
  if (status === 'rejected') return EXIT.PROTOCOL
  return EXIT.FAILED
}

function fail(error) {
  const code = error.code ?? 'CLI_ERROR'
  process.stderr.write(`${code}: ${error.message}\n`)
  if (code === 'UNKNOWN_ACTION' || code === 'BAD_FILE' || code === 'INVALID_ARGS' || code === 'BAD_USAGE') return EXIT.PROTOCOL
  if (code === 'STALE_BUILD' || code === 'UNSUPPORTED_PLATFORM' || code === 'UNSUPPORTED_PROFILE' || code === 'PACKAGED_MISSING' || code === 'UNKNOWN_SESSION' || code === 'HOST_GONE' || code === 'NO_SESSION') return EXIT.BLOCKED
  return EXIT.FAILED
}

async function main() {
  const { positionals, flags } = parseArgv(process.argv.slice(2))
  const json = Boolean(flags.json)
  const [group, sub] = positionals

  if (!group || flags.help) {
    log(USAGE)
    return EXIT.OK
  }

  switch (group) {
    case 'doctor': return cmdDoctor({ flags, json })
    case 'catalog': return cmdCatalog({ flags, json })
    case 'session': return cmdSession({ sub, flags, json, positionals })
    case 'invoke': return cmdInvoke({ flags, json, purpose: 'invoke' })
    case 'observe': return cmdInvoke({ flags, json, purpose: 'observe' })
    case 'assert': return cmdAssert({ flags, json })
    case 'evidence': return cmdEvidence({ flags, json })
    case 'suite': return cmdSuite({ sub, flags, json })
    case 'mcp-config': return cmdMcpConfig({ flags, json })
    case 'host': return cmdHost({ sub, flags, json })
    default:
      log(`未知命令：${group}\n\n${USAGE}`)
      return EXIT.PROTOCOL
  }
}

const USAGE = `pc-agent —— 外部 Agent 调用/测试轻语 PC 功能的终端入口（阶段 1）

  pc-agent doctor [--json] [--profile <profile>]
  pc-agent catalog [--module <namespace>] [--json]
  pc-agent session start --profile <source-isolated|packaged-isolated> [--allow-write <module>]... [--json]
  pc-agent session list [--json]
  pc-agent session get --session <id> [--json]
  pc-agent session restart --session <id> [--json]
  pc-agent session close --session <id> [--json]
  pc-agent invoke --session <id> --action <action-id> --args-file <绝对路径 JSON> [--no-wait] [--json]
  pc-agent observe --session <id> --action <action-id> [--args-file <路径>] [--json]
  pc-agent assert --session <id> --spec-file <绝对路径 JSON> [--json]
  pc-agent evidence --session <id> [--json]
  pc-agent suite run --session <id> --suite <chat.basic> [--json]
  pc-agent mcp-config [--client generic|codex|claude] [--json]
  pc-agent host list [--json]
  pc-agent host stop [--json]
`

async function cmdDoctor({ flags, json }) {
  assertSupportedProfile(flags.profile)
  const build = buildIdentity()
  const hosts = liveHosts()
  const report = {
    schemaVersion: 1,
    platform: process.platform,
    supported: process.platform === 'win32',
    profiles: PROFILES,
    build,
    stale: build.stale,
    hosts: hosts.map((host) => ({ hostId: host.hostId, pid: host.pid, sessionCount: host.sessionCount })),
    checks: [
      { name: '构建产物存在且不早于源码', pass: !build.stale, detail: build.stale ? build.staleReasons.join('；') : 'ok' },
      { name: '平台受支持', pass: process.platform === 'win32', detail: process.platform },
      { name: 'ACTIONS', pass: true, detail: '动作目录由 pnpm check:pc-agent 门禁校验' },
    ],
  }
  out(json ? report : formatDoctor(report), { json })
  return report.stale ? EXIT.BLOCKED : EXIT.OK
}

function assertSupportedProfile(profile) {
  if (profile && profile !== true && !PROFILES.includes(profile)) {
    const error = new Error(`不支持的 profile：${profile}（可用：${PROFILES.join(' / ')}）`)
    error.code = 'UNSUPPORTED_PROFILE'
    throw error
  }
}

function formatDoctor(report) {
  const lines = ['pc-agent doctor']
  lines.push(` 平台：${report.platform}${report.supported ? '' : '（不支持）'}`)
  lines.push(` git：${report.build.gitCommit ?? '-'} · electron：${report.build.electron ?? '-'}`)
  lines.push(` 最新源码：${report.build.newestSource.path ?? '-'} @ ${report.build.newestSource.mtime ?? '-'}`)
  for (const artifact of report.build.artifacts) {
    lines.push(` 产物 ${artifact.path}：${artifact.exists ? artifact.mtime : '缺失'}`)
  }
  lines.push(` 构建陈旧：${report.stale ? `是（${report.build.staleReasons.join('；')}）` : '否'}`)
  lines.push(` 活跃宿主：${report.hosts.length === 0 ? '无' : report.hosts.map((host) => `${host.hostId}(pid=${host.pid}, sessions=${host.sessionCount})`).join(', ')}`)
  return lines.join('\n')
}

async function cmdCatalog({ flags, json }) {
  const { loadActions } = await import('./lib/actions.mjs')
  const { describeAction } = await import('./lib/actions.mjs')
  const { executable, all, docs } = loadActions()
  const filter = flags.module
  const modules = docs
    .filter((doc) => !filter || doc.namespace === filter)
    .map((doc) => ({
      namespace: doc.namespace,
      apiInterface: doc.apiInterface,
      total: doc.actions.length,
      mapped: doc.actions.filter((action) => action.status === 'mapped').length,
    }))
  const actions = [...executable.values()]
    .filter((action) => !filter || action.namespace === filter)
    .map(describeAction)
  const report = { schemaVersion: 1, totals: { modules: docs.length, contractMembers: all.size, executable: executable.size }, modules, actions }
  out(json ? report : formatCatalog(report), { json })
  return EXIT.OK
}

function formatCatalog(report) {
  const lines = [`动作目录：${report.totals.executable}/${report.totals.contractMembers} 个动作已登记为可执行`]
  for (const module of report.modules) {
    lines.push(` ${module.namespace.padEnd(14)} mapped=${module.mapped}/${module.total}`)
  }
  if (report.actions.length > 0) {
    lines.push('', '可执行动作：')
    for (const action of report.actions) {
      lines.push(` ${action.id.padEnd(28)} ${action.write ? '写' : '读'} ${action.layer ?? '-'} ${action.description}`)
    }
  }
  return lines.join('\n')
}

async function cmdSession({ sub, flags, json, positionals }) {
  if (sub === 'list') {
    const registry = liveHosts()
    const { sessions } = await (async () => {
      const { readRegistry } = await import('./client.mjs')
      return readRegistry()
    })()
    const live = sessions.filter((entry) => registry.some((host) => host.hostId === entry.hostId))
    out(json ? { sessions: live } : live.length === 0 ? '无活跃会话' : live.map((entry) => `${entry.sessionId}  ${entry.profile}  ${entry.state}  ${entry.runDir}`).join('\n'), { json })
    return EXIT.OK
  }

  if (sub === 'get') {
    requireFlag(flags, 'session')
    const client = await AgentClient.forSession(flags.session)
    try {
      const result = await client.request('session.get')
      out(result, { json })
      return EXIT.OK
    } finally {
      client.close()
    }
  }

  if (sub === 'start') {
    assertSupportedProfile(flags.profile)
    const profile = flags.profile && flags.profile !== true ? flags.profile : 'source-isolated'
    const allowedWriteModules = toArray(flags['allow-write'])
    const client = await AgentClient.forHost()
    try {
      const result = await client.request('session.start', {
        profile,
        allowedWriteModules,
        allowStaleBuild: Boolean(flags['allow-stale-build']),
        allowCredentialWrite: Boolean(flags['allow-credential-write']),
        label: flags.label && flags.label !== true ? flags.label : profile,
      })
      const session = result.session
      out(json ? { session, runDir: result.runDir } : [
        `会话已启动：${session.sessionId}`,
        ` profile：${session.profile} · 状态：${session.state}`,
        ` run 目录：${session.runDir}`,
        ` 隔离 userData：${session.userDataDir}`,
        ` 允许写模块：${session.allowedWriteModules.length ? session.allowedWriteModules.join(', ') : '（无，仅读）'}`,
        ` 构建：${session.build.gitCommit ?? '-'} · 陈旧：${session.build.stale ? '是' : '否'}`,
      ].join('\n'), { json })
      client.close()
      return EXIT.OK
    } finally {
      client.close()
    }
  }

  if (sub === 'restart' || sub === 'close') {
    requireFlag(flags, 'session')
    const client = await AgentClient.forSession(flags.session)
    try {
      const method = sub === 'restart' ? 'session.restart' : 'session.close'
      const result = await client.request(method)
      out(result, { json })
      return EXIT.OK
    } finally {
      client.close()
    }
  }

  log(`未知 session 子命令：${sub ?? '(空)'}\n\n${USAGE}`)
  return EXIT.PROTOCOL
}

function toArray(value) {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

function requireFlag(flags, name) {
  if (!flags[name] || flags[name] === true) {
    const error = new Error(`缺少必需参数 --${name}\n\n${USAGE}`)
    error.code = 'BAD_USAGE'
    throw error
  }
}

async function cmdInvoke({ flags, json, purpose }) {
  requireFlag(flags, 'session')
  requireFlag(flags, 'action')
  const args = flags['args-file'] && flags['args-file'] !== true ? readJsonFile(flags['args-file'], '参数文件') : []
  if (!Array.isArray(args)) {
    const error = new Error('参数文件内容必须是数组（按契约参数顺序）')
    error.code = 'BAD_FILE'
    throw error
  }
  const client = await AgentClient.forSession(flags.session)
  try {
    const outcome = await client.request(purpose === 'observe' ? 'observe' : 'invoke', { action: flags.action, args, wait: !flags['no-wait'] })
    if (json) out(outcome, { json })
    else out(formatOutcome(outcome), { json: false })
    return exitCodeFor(outcome)
  } finally {
    client.close()
  }
}

function formatOutcome(outcome) {
  const lines = [
    `${outcome.status} · ${outcome.action} · layer=${outcome.layer ?? '-'} · op=${outcome.operationId}`,
    ` invoked=${outcome.invoked} verified=${outcome.verified}`,
  ]
  if (outcome.error) lines.push(` error: ${outcome.error.code} ${outcome.error.message}`)
  if (outcome.result !== undefined) lines.push(` result: ${JSON.stringify(outcome.result).slice(0, 400)}`)
  return lines.join('\n')
}

async function cmdAssert({ flags, json }) {
  requireFlag(flags, 'session')
  requireFlag(flags, 'spec-file')
  const specs = readJsonFile(flags['spec-file'], '断言规格文件')
  const list = Array.isArray(specs) ? specs : [specs]
  const client = await AgentClient.forSession(flags.session)
  try {
    const result = await client.request('assert', { specs: list })
    out(json ? result : `${result.summary.passed}/${result.summary.total} 条断言通过\n${result.records.map((record) => ` ${record.pass ? '✓' : '✗'} ${record.name}：expected=${JSON.stringify(record.expected)} actual=${JSON.stringify(record.actual)}`).join('\n')}`, { json })
    return result.summary.failed > 0 ? EXIT.FAILED : EXIT.OK
  } finally {
    client.close()
  }
}

async function cmdEvidence({ flags, json }) {
  requireFlag(flags, 'session')
  const client = await AgentClient.forSession(flags.session)
  try {
    const result = await client.request('evidence')
    out(json ? result : [
      `run 目录：${result.runDir}`,
      `动作 ${result.actions.length} 条，断言 ${result.summary.passed}/${result.summary.total} 通过`,
      ...result.actions.map((record) => ` ${record.status.padEnd(9)} ${record.action} ${record.elapsedMs}ms`),
    ].join('\n'), { json })
    return EXIT.OK
  } finally {
    client.close()
  }
}

async function cmdSuite({ sub, flags, json }) {
  if (sub !== 'run') {
    log(`未知 suite 子命令：${sub ?? '(空)'}\n\n${USAGE}`)
    return EXIT.PROTOCOL
  }
  requireFlag(flags, 'session')
  requireFlag(flags, 'suite')
  const { loadSuite, listSuites } = await import('./suites/index.mjs')
  const suite = loadSuite(flags.suite)
  if (!suite) {
    log(`未知 suite：${flags.suite}（可用：${listSuites().join(', ')}）`)
    return EXIT.PROTOCOL
  }
  const client = await AgentClient.forSession(flags.session)
  try {
    const result = await suite.run({
      request: (method, params) => client.request(method, params),
      sessionId: flags.session,
      log: (message) => log(`  ${message}`),
    })
    out(json ? result : formatSuiteResult(result), { json })
    return result.passed ? EXIT.OK : EXIT.FAILED
  } finally {
    client.close()
  }
}

function formatSuiteResult(result) {
  const lines = [`suite ${result.suite}：${result.passed ? '通过' : '未通过'}`]
  for (const step of result.steps) {
    lines.push(` ${step.pass ? '✓' : '✗'} ${step.name}${step.detail ? ` — ${step.detail}` : ''}`)
  }
  lines.push(` 证据：${result.runDir}`)
  return lines.join('\n')
}

/** 生成外部 Agent 的 MCP 注册描述；由工具包生成，用户不需要在 PC 产品里启用任何功能 */
async function cmdMcpConfig({ flags, json }) {
  const { mcpConfig } = await import('./lib/mcp-config.mjs')
  const client = flags.client && flags.client !== true ? flags.client : 'generic'
  const config = mcpConfig(client)
  out(json ? config : config.text, { json })
  return EXIT.OK
}

async function cmdHost({ sub, flags, json }) {  if (sub === 'list') {
    const hosts = liveHosts()
    out(json ? { hosts } : hosts.length === 0 ? '无活跃宿主' : hosts.map((host) => `${host.hostId}  pid=${host.pid}  sessions=${host.sessionCount}  ${host.pipe}`).join('\n'), { json })
    return EXIT.OK
  }
  if (sub === 'stop') {
    const hosts = liveHosts()
    const stopped = []
    for (const host of hosts) {
      try {
        const client = await AgentClient.forHost()
        await client.request('host.stop')
        client.close()
        stopped.push(host.hostId)
        break
      } catch (error) {
        process.stderr.write(`停止宿主 ${host.hostId} 失败：${error.message}\n`)
      }
    }
    out(json ? { stopped } : stopped.length ? `已停止宿主：${stopped.join(', ')}` : '无宿主可停止', { json })
    return EXIT.OK
  }
  log(`未知 host 子命令：${sub ?? '(空)'}\n\n${USAGE}`)
  return EXIT.PROTOCOL
}

try {
  process.exitCode = await main()
} catch (error) {
  process.exitCode = fail(error)
}

export { createRunDir, OUTPUT_ROOT }




