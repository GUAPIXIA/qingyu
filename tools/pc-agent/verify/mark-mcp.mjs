#!/usr/bin/env node
// MCP 动作登记升级：用户提供了真实外部 MCP 服务（uTools MCP 网关），这些动作现在可验证。
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const path = resolve('tools/pc-agent/catalog/mcp.json')
const doc = JSON.parse(readFileSync(path, 'utf8'))

const SPECS = {
  'mcp.listServers': { k: 'mapped', w: false, d: '列出已配置的 MCP 服务器', a: ['返回服务器数组'] },
  'mcp.listServerStatuses': { k: 'mapped', w: false, d: '列出 MCP 服务器运行状态', a: ['返回状态数组'] },
  'mcp.addServer': { k: 'mapped', w: true, d: '添加 MCP 服务器配置', a: ['返回新服务器 id'], s: '写入隔离档案的 MCP 配置' },
  'mcp.updateServer': { k: 'mapped', w: true, d: '更新 MCP 服务器配置', a: ['返回更新后的配置'], s: '修改隔离档案的 MCP 配置' },
  'mcp.removeServer': { k: 'mapped', w: true, d: '删除 MCP 服务器配置', a: ['删除后列表不含该服务器'], s: '删除隔离档案的 MCP 配置' },
  'mcp.startServer': { k: 'mapped', w: true, d: '启动 MCP 服务器（stdio 已实现；sse/http 未实现）', a: ['成功或给出可读的未实现/连接错误'], s: '拉起子进程或连接外部服务' },
  'mcp.stopServer': { k: 'mapped', w: true, d: '停止 MCP 服务器', a: ['停止后状态非 connected'], s: '结束子进程或连接' },
  'mcp.listTools': { k: 'mapped', w: false, d: '列出已连接服务器的工具', a: ['返回工具数组'] },
  'mcp.callTool': {
    k: 'pending', w: false, d: '调用外部 MCP 工具',
    r: ['external-tool'], pr: '会执行第三方工具（可能读写本机数据），需用户显式授权后按具体工具逐个验证；本轮只验证连接与工具发现',
  },
}

let changed = 0
for (const action of doc.actions) {
  const spec = SPECS[action.id]
  if (!spec) continue
  action.status = spec.k
  action.description = spec.d
  action.write = spec.w
  action.requires = spec.r ?? []
  action.pendingReason = spec.pr ?? null
  action.assertions = spec.a ?? []
  action.sideEffect = spec.s ?? (spec.w ? '写入隔离测试档案' : '无')
  changed += 1
}
writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
console.log(`已登记 MCP 动作：${changed} 个`)
