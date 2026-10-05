#!/usr/bin/env node
// F5 复现/验证登记：ui.chat.selectSession 改用 role=menuitem 定位（产品侧下拉项已加菜单语义），
// 避免与同名触发器（role=button，显示当前会话标题）撞名。
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const path = resolve('tools/pc-agent/catalog/_tools.json')
const doc = JSON.parse(readFileSync(path, 'utf8'))
const action = doc.actions.find((item) => item.id === 'ui.chat.selectSession')
if (!action) {
  console.error('未找到 ui.chat.selectSession')
  process.exit(1)
}
action.status = 'mapped'
action.pendingReason = null
action.description = '在会话切换器中选中标题匹配的会话（真实界面操作，按菜单项语义定位）'
action.ui = {
  kind: 'click',
  pre: [
    { kind: 'navigate', name: '对话', exact: true, settleMs: 500 },
    { kind: 'click', title: '切换对话', exact: true, settleMs: 600 },
  ],
  role: 'menuitem',
  regex: true,
  name: '^{{0}}$',
  settleMs: 800,
}
action.assertions = ['点击后当前会话标题变为目标标题（见 ui.chat.readSelectedTitle）']
writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
console.log('已登记 ui.chat.selectSession：role=menuitem（待产品侧加菜单语义后验证）')
