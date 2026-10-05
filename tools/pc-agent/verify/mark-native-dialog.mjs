#!/usr/bin/env node
// 原生对话框动作登记：声明 dialog 规格，使会话在 --allow-native-dialog 时可用桌面自动化后端完成。
// 目标路径一律落在本次 run 目录的 exports/ 下（证据所有权明确）。
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const CATALOG = resolve('tools/pc-agent/catalog')

const SPECS = {
  'character.json': {
    'character.exportJson': { kind: 'save', pathTemplate: 'exports/character-{{stamp}}.json', ext: 'JSON 角色卡' },
    'character.exportPng': { kind: 'save', pathTemplate: 'exports/character-{{stamp}}.png', ext: 'PNG 角色卡' },
    'character.exportCover': { kind: 'save', pathTemplate: 'exports/character-cover-{{stamp}}.png', ext: '封面图' },
    'character.importJson': { kind: 'open', ext: 'JSON 角色卡' },
    'character.importPng': { kind: 'open', ext: 'PNG 角色卡' },
  },
  'lorebook.json': {
    'lorebook.exportJson': { kind: 'save', pathTemplate: 'exports/lorebook-{{stamp}}.json', ext: '世界书 JSON' },
    'lorebook.importJsonDetailed': { kind: 'open', ext: '世界书 JSON' },
  },
  'preset.json': {
    'preset.exportJson': { kind: 'save', pathTemplate: 'exports/preset-{{stamp}}.json', ext: '预设 JSON' },
    'preset.importJson': { kind: 'open', ext: '预设 JSON' },
  },
  'settings.json': {
    'settings.exportBackup': { kind: 'save', pathTemplate: 'exports/backup-{{stamp}}.zip', ext: '备份 ZIP' },
  },
  'quickReply.json': {
    'quickReply.exportJson': { kind: 'save', pathTemplate: 'exports/quickreply-{{stamp}}.json', ext: '快捷回复 JSON' },
  },
  'font.json': {
    'font.selectFont': { kind: 'open', ext: '字体文件' },
  },
  'file.json': {
    'file.selectImage': { kind: 'open', ext: '图片文件' },
  },
}

let changed = 0
for (const [file, spec] of Object.entries(SPECS)) {
  const path = resolve(CATALOG, file)
  const doc = JSON.parse(readFileSync(path, 'utf8'))
  for (const action of doc.actions) {
    const mark = spec[action.id]
    if (!mark) continue
    action.dialog = { kind: mark.kind, pathTemplate: mark.pathTemplate ?? null, note: mark.ext }
    action.pendingReason = `${action.pendingReason ?? '需要系统原生对话框'}；已接入桌面自动化后端，开启 --allow-native-dialog 后可用（目标路径写入本次 run 的 exports/）`
    changed += 1
  }
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
}

console.log(`已登记原生对话框动作：${changed} 个`)
