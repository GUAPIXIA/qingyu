#!/usr/bin/env node
/**
 * 阶段 0：生成确定性 10k 单聊消息 JSONL（合成，无隐私）。
 * 用法: node scripts/gen-phase0-messages-10k.mjs
 * 输出: shared/fixtures/cross-platform/baseline/sessions/single-chat/messages-10k.jsonl
 */
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const out = join(__dirname, '../shared/fixtures/cross-platform/baseline/sessions/single-chat/messages-10k.jsonl')

const lines = []
for (let i = 1; i <= 10000; i++) {
  const role = i % 2 === 1 ? 'user' : 'assistant'
  const id = `msg-10k-${String(i).padStart(5, '0')}`
  const msg = {
    id,
    sessionId: 'sess-single-10k',
    role,
    content: `合成第${i}条：${role === 'user' ? '推进剧情' : '角色回应'}。`,
    timestamp: 1789562000000 + i * 1000,
    swipes: [{ id: `${id}-s0`, content: `合成第${i}条：${role === 'user' ? '推进剧情' : '角色回应'}。`, index: 0, isEdited: false }],
    swipeId: 0,
    isEdited: false,
    isDeleted: i === 4242,
  }
  if (i === 5000) {
    msg.isEdited = true
    msg.swipes[0].isEdited = true
    msg.content = `合成第${i}条：编辑后。`
    msg.swipes[0].content = msg.content
  }
  if (i === 7000) {
    msg.swipes.push({ id: `${id}-s1`, content: `合成第${i}条：备用 swipe。`, index: 1, isEdited: false })
    msg.swipeId = 1
  }
  lines.push(JSON.stringify(msg))
}

writeFileSync(out, lines.join('\n') + '\n', 'utf8')
console.log(`wrote ${lines.length} messages -> ${out}`)
