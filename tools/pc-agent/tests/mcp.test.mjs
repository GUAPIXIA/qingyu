// 阶段 2 自测：双入口等价比较、MCP 工具定义、MCP 握手与 stdout 纯净性。
// 握手用例会真实拉起 mcp-server.mjs（不启动 Electron、不需要会话）。
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { compareOutcomes, isJsonRpcLine, normalizeOutcome } from '../lib/equivalence.mjs'
import { CLIENTS, MCP_SERVER_PATH, mcpConfig } from '../lib/mcp-config.mjs'
import { SERVER_NAME, normalizeArgs, toolDefinitions } from '../mcp-server.mjs'
import { loadActions } from '../lib/actions.mjs'
import { sanitizedEnv } from '../platform.mjs'

const actions = loadActions()

describe('双入口等价比较', () => {
  it('忽略 operationId/sessionId/耗时，只比较协议可比字段', () => {
    const cli = { status: 'succeeded', action: 'app.getVersion', layer: 'ipc', invoked: true, verified: false, operationId: 'op-1', sessionId: 'a', result: '0.18.0' }
    const mcp = { status: 'succeeded', action: 'app.getVersion', layer: 'ipc', invoked: true, verified: false, operationId: 'op-2', sessionId: 'b', result: '0.18.0' }
    expect(compareOutcomes(cli, mcp).equivalent).toBe(true)
    expect(normalizeOutcome(cli).operationId).toBeUndefined()
  })

  it('结果不同即判定不等价，并给出差异字段', () => {
    const cli = { status: 'succeeded', action: 'character.list', layer: 'ipc', invoked: true, verified: false, result: [{ id: 'a' }] }
    const mcp = { status: 'succeeded', action: 'character.list', layer: 'ipc', invoked: true, verified: false, result: [{ id: 'b' }] }
    const comparison = compareOutcomes(cli, mcp)
    expect(comparison.equivalent).toBe(false)
    expect(comparison.differences.map((item) => item.field)).toContain('result')
  })

  it('状态不同即判定不等价', () => {
    const comparison = compareOutcomes(
      { status: 'succeeded', action: 'x', layer: 'ipc', invoked: true, result: 1 },
      { status: 'blocked', action: 'x', layer: 'ipc', invoked: false, result: null },
    )
    expect(comparison.equivalent).toBe(false)
    expect(comparison.differences.map((item) => item.field)).toEqual(expect.arrayContaining(['status', 'invoked', 'result']))
  })

  it('嵌套对象按深比较', () => {
    const base = { status: 'succeeded', action: 'x', layer: 'ipc', invoked: true, result: { a: { b: [1, 2] } } }
    expect(compareOutcomes(base, structuredClone(base)).equivalent).toBe(true)
    const changed = structuredClone(base)
    changed.result.a.b = [1, 3]
    expect(compareOutcomes(base, changed).equivalent).toBe(false)
  })

  it('stdout 行判定：JSON-RPC 合法、日志非法', () => {
    expect(isJsonRpcLine('{"jsonrpc":"2.0","id":1,"result":{}}')).toBe(true)
    expect(isJsonRpcLine('{"jsonrpc":"2.0","method":"notifications/initialized"}')).toBe(true)
    expect(isJsonRpcLine('')).toBe(true)
    expect(isJsonRpcLine('[qingyu-pc-agent] 已就绪')).toBe(false)
    expect(isJsonRpcLine('{"not":"jsonrpc"}')).toBe(false)
  })
})

describe('MCP 工具定义', () => {
  const tools = toolDefinitions()

  it('暴露方案 §5.3 的 9 个基础工具', () => {
    expect(tools.map((tool) => tool.name)).toEqual([
      'qingyu_doctor', 'qingyu_capabilities', 'qingyu_session', 'qingyu_call', 'qingyu_observe',
      'qingyu_operation', 'qingyu_assert', 'qingyu_run_suite', 'qingyu_evidence',
    ])
  })

  it('每个工具都有标题、说明与对象型 inputSchema', () => {
    for (const tool of tools) {
      expect(tool.title).toBeTruthy()
      expect(tool.description.length).toBeGreaterThan(10)
      expect(tool.inputSchema.type).toBe('object')
      expect(tool.inputSchema.additionalProperties).toBe(false)
    }
  })

  it('需要会话的工具都把 sessionId 标为必填', () => {
    const requireSession = ['qingyu_call', 'qingyu_observe', 'qingyu_assert', 'qingyu_run_suite', 'qingyu_evidence']
    for (const name of requireSession) {
      const tool = tools.find((item) => item.name === name)
      expect(tool.inputSchema.required).toContain('sessionId')
    }
    expect(tools.find((item) => item.name === 'qingyu_doctor').inputSchema.required ?? []).toEqual([])
  })

  it('suite 与 profile 用枚举约束，避免 Agent 猜值', () => {
    const suites = tools.find((item) => item.name === 'qingyu_run_suite').inputSchema.properties.suite.enum
    expect(suites).toContain('chat.lifecycle')
    expect(suites).toContain('spatial.lifecycle')
    expect(suites.length).toBe(19)
    expect(tools.find((item) => item.name === 'qingyu_session').inputSchema.properties.profile.enum).toEqual(['source-isolated', 'packaged-isolated'])
  })

  it('会话工具动作枚举覆盖 start/list/get/restart/close', () => {
    expect(tools.find((item) => item.name === 'qingyu_session').inputSchema.properties.action.enum)
      .toEqual(['start', 'list', 'get', 'restart', 'close'])
  })
})

describe('命名参数摊平', () => {
  const rename = actions.all.get('chat.renameSession')

  it('按契约顺序摊平命名参数', () => {
    expect(normalizeArgs(rename, { characterId: 'c', sessionId: 's', title: 't' })).toEqual(['c', 's', 't'])
  })

  it('显式 args 数组优先', () => {
    expect(normalizeArgs(rename, { args: ['x', 'y', 'z'], characterId: 'ignored' })).toEqual(['x', 'y', 'z'])
  })

  it('无参动作返回空数组', () => {
    expect(normalizeArgs(actions.all.get('app.getVersion'), {})).toEqual([])
  })
})

describe('MCP 注册描述', () => {
  it('三种客户端都能生成，且指向绝对路径的 server', () => {
    for (const client of CLIENTS) {
      const config = mcpConfig(client)
      expect(config.server.args[0]).toBe(MCP_SERVER_PATH)
      expect(config.server.command).toBe('node')
      expect(config.text).toContain('mcp-server.mjs')
    }
  })

  it('generic/claude 给 JSON，codex 给 TOML', () => {
    expect(mcpConfig('generic').json.mcpServers['qingyu-pc-agent']).toBeTruthy()
    expect(mcpConfig('codex').text).toContain('[mcp_servers.qingyu-pc-agent]')
  })

  it('未知客户端被拒绝', () => {
    expect(() => mcpConfig('nope')).toThrow(/未知客户端/)
  })
})

describe('MCP stdio 握手', () => {
  it('握手 + tools/list 成功，且 stdout 只含 JSON-RPC', async () => {
    const { env } = sanitizedEnv()
    const child = spawn(process.execPath, [MCP_SERVER_PATH], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const stdoutLines = []
    let buffer = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (line.trim()) stdoutLines.push(line)
        index = buffer.indexOf('\n')
      }
    })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })

    const responses = new Map()
    child.stdout.on('data', () => {
      for (const line of stdoutLines) {
        try {
          const message = JSON.parse(line)
          if (message.id !== undefined) responses.set(message.id, message)
        } catch {
          // 由断言负责报告
        }
      }
    })

    const send = (payload) => child.stdin.write(`${JSON.stringify(payload)}\n`)
    const waitFor = async (id, timeoutMs = 20000) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (responses.has(id)) return responses.get(id)
        await new Promise((done) => setTimeout(done, 100))
      }
      throw new Error(`未在 ${timeoutMs}ms 内收到 id=${id} 的响应`)
    }

    try {
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'vitest', version: '0' } } })
      const init = await waitFor(1)
      expect(init.result.serverInfo.name).toBe(SERVER_NAME)
      send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
      const list = await waitFor(2)
      expect(list.result.tools.length).toBe(9)

      expect(stdoutLines.every((line) => isJsonRpcLine(line))).toBe(true)
      expect(stderr).toContain('[qingyu-pc-agent]')
      expect(stdoutLines.join('\n')).not.toContain('已就绪')
    } finally {
      child.kill()
      await new Promise((done) => setTimeout(done, 300))
    }
  }, 40000)
})





