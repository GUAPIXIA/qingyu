#!/usr/bin/env node
// 外部 MCP stdio 入口：把同一套动作目录与同一个 Session Host 暴露为 MCP 工具。
// 设计约束（方案 §3、§5.3、§10）：
//  - 不实现第二套执行逻辑：所有工具都经 client.mjs 调宿主，与 CLI 完全同路径；
//  - stdout 只允许 MCP 协议消息：日志一律走 stderr，不打印令牌等凭据；
//  - 工具集少量入口 + 可发现目录，不把 254 个底层方法一次塞给 Agent。
//
// 用法（由外部 Agent 注册，不需要手工执行）：
//   node tools/pc-agent/mcp-server.mjs
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AgentClient, ensureHost, liveHosts, readRegistry } from './client.mjs'
import { loadActions } from './lib/actions.mjs'
import { buildIdentity } from './platform.mjs'
import { listSuites, loadSuite } from './suites/index.mjs'

const SERVER_NAME = 'qingyu-pc-agent'
const SERVER_VERSION = '0.2.0'

/** stderr 日志：stdout 留给 MCP 协议 */
function log(message) {
  process.stderr.write(`[${SERVER_NAME}] ${message}\n`)
}

const ACTIONS = loadActions()

/** 把命名参数按契约顺序摊平成位置参数；也接受直接传 args 数组 */
function normalizeArgs(action, input) {
  if (Array.isArray(input.args)) return input.args
  const params = action.params ?? []
  if (params.length === 0) return []
  const positional = params.map((param) => input[param.name])
  if (positional.some((value) => value === undefined) && params.some((param) => param.required)) {
    // 缺必填参数时保持原样，交由宿主侧参数校验给出明确错误
    return positional
  }
  return positional
}

function toolDefinitions() {
  const executable = [...ACTIONS.executable.values()]
  const actionList = executable.map((action) => ({
    id: action.id,
    description: action.description,
    write: action.write === true,
    layer: action.layer,
    params: (action.params ?? []).map((param) => `${param.name}${param.required ? '' : '?'}:${param.type}`),
  }))

  return [
    {
      name: 'qingyu_doctor',
      title: '环境与构建检查',
      description: '检查平台、构建产物、构建陈旧与活跃宿主。构建陈旧时不应继续驱动客户端。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'qingyu_capabilities',
      title: '动作能力目录',
      description: `返回已登记为可执行的动作（当前 ${actionList.length}/${ACTIONS.all.size}）及其参数、层级、是否写动作。执行前先看这里。`,
      inputSchema: {
        type: 'object',
        properties: { module: { type: 'string', description: '只返回该命名空间的动作，如 chat' } },
        additionalProperties: false,
      },
    },
    {
      name: 'qingyu_session',
      title: '受控会话管理',
      description: '启动/列出/查看/重启/关闭隔离的真实客户端会话。写动作需要显式 allowWriteModules 授权。',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['start', 'list', 'get', 'restart', 'close'] },
          sessionId: { type: 'string', description: 'get/restart/close 需要' },
          profile: { type: 'string', enum: ['source-isolated', 'packaged-isolated'], description: 'start 需要，默认 source-isolated' },
          allowWriteModules: { type: 'array', items: { type: 'string' }, description: '允许写动作的模块，如 ["character","chat"]' },
          label: { type: 'string' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
    {
      name: 'qingyu_call',
      title: '调用已登记动作',
      description: '按动作目录调用现有功能（可能产生副作用，需会话已授权对应模块）。返回 status/invoked/verified/result。',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          action: { type: 'string', description: `动作 id，如 ${actionList.slice(0, 3).map((item) => item.id).join(' / ')}` },
          args: { type: 'array', items: {}, description: '按契约参数顺序的位置参数' },
          wait: { type: 'boolean', description: '异步动作是否等待终态，默认 true；false 时只返回 taskId 句柄（可用 qingyu_operation 查询或取消）' },
        },
        required: ['sessionId', 'action'],
        additionalProperties: false,
      },
    },
    {
      name: 'qingyu_observe',
      title: '只读读取状态',
      description: '执行只读动作读取业务状态，不会触发写动作授权检查。用于读回与核对。',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          action: { type: 'string' },
          args: { type: 'array', items: {} },
        },
        required: ['sessionId', 'action'],
        additionalProperties: false,
      },
    },
    {
      name: 'qingyu_operation',
      title: '查询异步操作',
      description: '按 operationId 查询动作记录。阶段 2 只支持同步 IPC 动作（返回即终结）；生成类异步等待在阶段 3 接入。',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          operationId: { type: 'string' },
        },
        required: ['sessionId'],
        additionalProperties: false,
      },
    },
    {
      name: 'qingyu_assert',
      title: '执行有限断言',
      description: '断言规格数组：{action,args,where?,path?,op,expected}；op ∈ equals/contains/length/exists/absent/gte。返回 expected/actual 与结论。',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          specs: { type: 'array', items: { type: 'object' }, description: '断言规格数组' },
        },
        required: ['sessionId', 'specs'],
        additionalProperties: false,
      },
    },
    {
      name: 'qingyu_run_suite',
      title: '运行测试旅程',
      description: `运行固定测试旅程。可用：${listSuites().join(', ')}。`,
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          suite: { type: 'string', enum: listSuites() },
        },
        required: ['sessionId', 'suite'],
        additionalProperties: false,
      },
    },
    {
      name: 'qingyu_evidence',
      title: '获取证据索引',
      description: '返回该会话 run 目录、动作记录、断言记录与汇总。',
      inputSchema: {
        type: 'object',
        properties: { sessionId: { type: 'string' } },
        required: ['sessionId'],
        additionalProperties: false,
      },
    },
  ]
}

async function withSession(sessionId, fn) {
  const client = await AgentClient.forSession(sessionId)
  try {
    return await fn(client)
  } finally {
    client.close()
  }
}

const handlers = {
  async qingyu_doctor() {
    const build = buildIdentity()
    const registry = readRegistry()
    return {
      platform: process.platform,
      supported: process.platform === 'win32',
      build,
      stale: build.stale,
      hosts: liveHosts().map((host) => ({ hostId: host.hostId, pid: host.pid, sessionCount: host.sessionCount })),
      sessions: registry.sessions.map((entry) => ({ sessionId: entry.sessionId, profile: entry.profile, state: entry.state })),
    }
  },

  async qingyu_capabilities(input) {
    const filter = input.module
    const actions = [...ACTIONS.executable.values()]
      .filter((action) => !filter || action.namespace === filter)
      .map((action) => ({
        id: action.id,
        description: action.description,
        layer: action.layer,
        write: action.write === true,
        cancelable: action.cancelable ?? null,
        params: action.params,
        returns: action.returns,
        assertions: action.assertions ?? [],
      }))
    return {
      totals: { modules: ACTIONS.docs.length, contractMembers: ACTIONS.all.size, executable: ACTIONS.executable.size },
      actions,
    }
  },

  async qingyu_session(input) {
    if (input.action === 'start') {
      const client = await AgentClient.forHost()
      try {
        const result = await client.request('session.start', {
          profile: input.profile ?? 'source-isolated',
          allowedWriteModules: input.allowWriteModules ?? [],
          label: input.label ?? input.profile ?? 'mcp-session',
        })
        return result
      } finally {
        client.close()
      }
    }
    if (input.action === 'list') {
      const registry = readRegistry()
      const hosts = new Set(liveHosts().map((host) => host.hostId))
      return { sessions: registry.sessions.filter((entry) => hosts.has(entry.hostId)) }
    }
    if (!input.sessionId) throw new Error(`${input.action} 需要 sessionId`)
    if (input.action === 'get') return withSession(input.sessionId, (client) => client.request('session.get'))
    if (input.action === 'restart') return withSession(input.sessionId, (client) => client.request('session.restart'))
    if (input.action === 'close') return withSession(input.sessionId, (client) => client.request('session.close'))
    throw new Error(`未知 session action：${input.action}`)
  },

  async qingyu_call(input) {
    // 不在 MCP 层预判动作是否存在：未知动作交给宿主，返回与 CLI 一致的 rejected / UNKNOWN_ACTION
    const action = ACTIONS.all.get(input.action)
    const args = action ? normalizeArgs(action, input) : input.args ?? []
    return withSession(input.sessionId, (client) => client.request('invoke', { action: input.action, args, wait: input.wait !== false }))
  },

  async qingyu_observe(input) {
    const action = ACTIONS.all.get(input.action)
    const args = action ? normalizeArgs(action, input) : input.args ?? []
    return withSession(input.sessionId, (client) => client.request('observe', { action: input.action, args }))
  },

  async qingyu_operation(input) {
    const evidence = await withSession(input.sessionId, (client) => client.request('evidence'))
    const records = input.operationId
      ? evidence.actions.filter((record) => record.operationId === input.operationId)
      : evidence.actions
    return {
      operations: records.map((record) => ({
        operationId: record.operationId,
        action: record.action,
        status: record.status,
        invoked: record.invoked,
        elapsedMs: record.elapsedMs,
        error: record.error,
      })),
      note: '阶段 2：同步 IPC 动作返回即终结；事件型异步等待在阶段 3 接入。',
    }
  },

  async qingyu_assert(input) {
    return withSession(input.sessionId, (client) => client.request('assert', { specs: input.specs }))
  },

  async qingyu_run_suite(input) {
    const suite = loadSuite(input.suite)
    if (!suite) throw new Error(`未知 suite：${input.suite}`)
    return withSession(input.sessionId, (client) => suite.run({
      request: (method, params) => client.request(method, params),
      sessionId: input.sessionId,
      log: (message) => log(message),
    }))
  },

  async qingyu_evidence(input) {
    return withSession(input.sessionId, (client) => client.request('evidence'))
  },
}

const server = new Server(
  { name: SERVER_NAME, version: SERVER_VERSION },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefinitions() }))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: input = {} } = request.params
  const handler = handlers[name]
  if (!handler) {
    return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: { code: 'UNKNOWN_TOOL', message: `未知工具：${name}` } }) }], isError: true }
  }
  try {
    const result = await handler(input)
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  } catch (error) {
    log(`工具 ${name} 失败：${error.message}`)
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ ok: false, error: { code: error.code ?? 'TOOL_FAILED', message: String(error.message) } }, null, 2),
      }],
      isError: true,
    }
  }
})

async function main() {
  await ensureHost().catch((error) => log(`宿主预检失败（会话操作时仍会重试）：${error.message}`))
  const transport = new StdioServerTransport()
  await server.connect(transport)
  log(`已就绪：${SERVER_NAME} v${SERVER_VERSION}，可执行动作 ${ACTIONS.executable.size}/${ACTIONS.all.size}，suite ${listSuites().join(', ')}`)
}

// 仅在作为入口直接运行时连接 stdio；被测试 import 时不启动传输
const isDirectRun = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isDirectRun) {
  main().catch((error) => {
    log(`启动失败：${error.stack ?? error.message}`)
    process.exit(1)
  })
}

export { SERVER_NAME, SERVER_VERSION, toolDefinitions, normalizeArgs }

