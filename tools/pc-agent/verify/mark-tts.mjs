#!/usr/bin/env node
// TTS 真实验证登记：tts.* 在“有可用 TTS provider”时可验证。
// 说明：小米 MiMo TTS 走 /chat/completions + audio 字段，与产品 openai 兼容路径（/audio/speech）不同，
// 因此产品侧真实合成用 edge provider 验证；MiMo 兼容性单独作为“集成缺口”步骤记录。
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const path = resolve('tools/pc-agent/catalog/tts.json')
const doc = JSON.parse(readFileSync(path, 'utf8'))

const SPECS = {
  'tts.speak': {
    k: 'mapped', w: false, d: '朗读文本（真实合成：edge provider 返回 mp3 base64）',
    a: ['success=true 且返回音频字节', '失败时给出可读错误而非崩溃'],
    s: '本机播放音频（隔离档案内触发）',
  },
  'tts.stop': { k: 'mapped', w: false, d: '停止朗读', a: ['success=true 且状态回到 idle'], s: '停止本机播放' },
  'tts.pause': { k: 'mapped', w: false, d: '暂停朗读', a: ['success=true'], s: '暂停本机播放' },
  'tts.resume': { k: 'mapped', w: false, d: '恢复朗读', a: ['success=true'], s: '恢复本机播放' },
  'tts.getState': { k: 'mapped', w: false, d: '读取朗读状态', a: ['state ∈ idle/speaking/paused'] },
  'tts.listVoices': { k: 'mapped', w: false, d: '列出音色（按 provider）', a: ['返回非空音色列表'] },
}

let changed = 0
for (const action of doc.actions) {
  const mark = SPECS[action.id]
  if (!mark) continue
  action.status = mark.k
  action.description = mark.d
  action.layer = 'ipc'
  action.write = mark.w
  action.requires = []
  action.awaitTask = null
  action.pendingReason = null
  action.assertions = mark.a
  action.sideEffect = mark.s
  changed += 1
}
writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
console.log(`已登记 TTS 动作：${changed} 个`)
