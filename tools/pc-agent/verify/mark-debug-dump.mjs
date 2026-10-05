#!/usr/bin/env node
// 诊断用工具动作：返回当前页面 URL 与关键角色元素清单，便于定位 UI 动作失败原因
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const path = resolve('tools/pc-agent/catalog/_tools.json')
const doc = JSON.parse(readFileSync(path, 'utf8'))
if (!doc.actions.some((item) => item.id === 'ui.debugDump')) {
  doc.actions.push({
    id: 'ui.debugDump',
    apiPath: null,
    origin: 'tool',
    adapter: 'ui',
    kind: 'tool',
    status: 'mapped',
    signature: 'ui.debugDump()',
    params: [],
    returns: 'object',
    description: '诊断：返回当前页面 URL 与可见的角色元素清单（button/link/menuitem/menu）',
    layer: 'ui',
    write: false,
    requires: [],
    redactKeys: [],
    awaitTask: null,
    ui: { kind: 'debugDump', settleMs: 200 },
    assertions: ['返回 url 与元素清单'],
    evidence: [],
  })
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
  console.log('已登记 ui.debugDump')
} else {
  console.log('ui.debugDump 已存在')
}
