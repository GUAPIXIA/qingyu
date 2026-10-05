#!/usr/bin/env node
// 免对话框登记：导出/导入类动作在传入显式路径时不再弹系统对话框（产品侧已支持），
// 因此这些动作在「传了路径」的情况下可被真实执行；不传路径仍返回 needs_interaction。
//
// 约定：dialog.pathArg = 提供路径的参数下标（0 基）。执行器据此判断是否放行。
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const CATALOG = resolve('tools/pc-agent/catalog')

/** apiPath → { kind, pathArg } */
const SPECS = {
  'window.api.character.exportJson': { kind: 'save', pathArg: 1 },
  'window.api.character.exportPng': { kind: 'save', pathArg: 1 },
  'window.api.character.exportCover': { kind: 'save', pathArg: 1 },
  'window.api.character.importJson': { kind: 'open', pathArg: 1 },
  'window.api.character.importPng': { kind: 'open', pathArg: 1 },
  'window.api.character.importBatch': { kind: 'open', pathArg: 1 },
  'window.api.lorebook.exportJson': { kind: 'save', pathArg: 2 },
  'window.api.lorebook.importJsonDetailed': { kind: 'open', pathArg: 1 },
  'window.api.lorebook.openMappingSource': { kind: 'open', pathArg: 0 },
  'window.api.preset.exportJson': { kind: 'save', pathArg: 1 },
  'window.api.preset.importJson': { kind: 'open', pathArg: 0 },
  'window.api.quickReply.exportJson': { kind: 'save', pathArg: 0 },
  'window.api.quickReply.importJson': { kind: 'open', pathArg: 0 },
  'window.api.settings.exportBackup': { kind: 'save', pathArg: 0 },
  'window.api.settings.importBackup': { kind: 'open', pathArg: 0 },
}

/** 这些动作故意**不**加路径参数（见阶段 5 报告 §12.3）：它们是防任意文件读取的白名单闸门 */
const DELIBERATELY_DIALOG_ONLY = ['window.api.file.selectImage', 'window.api.font.selectFont']

let changed = 0
for (const file of ['character.json', 'lorebook.json', 'preset.json', 'quickReply.json', 'settings.json']) {
  const path = resolve(CATALOG, file)
  const doc = JSON.parse(readFileSync(path, 'utf8'))
  for (const action of doc.actions) {
    const spec = SPECS[action.apiPath]
    if (!spec) continue
    action.dialog = { kind: spec.kind, pathArg: spec.pathArg }
    action.pendingReason = null
    action.requires = []
    action.status = 'mapped'
    action.description = `${action.description.replace(/（.*?对话框.*?）/g, '')}（传 ${spec.kind === 'save' ? 'targetPath' : 'sourcePath'} 时不弹对话框）`
    changed += 1
  }
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
}

// 明确保留为对话框专用的两个动作：注明原因，避免后人误以为漏改
for (const file of ['file.json', 'font.json']) {
  const path = resolve(CATALOG, file)
  const doc = JSON.parse(readFileSync(path, 'utf8'))
  for (const action of doc.actions) {
    if (!DELIBERATELY_DIALOG_ONLY.includes(action.apiPath)) continue
    action.pendingReason = `${action.pendingReason ?? '需要系统原生对话框'}；**故意不提供路径参数**：该动作是「仅允许读取对话框选择过的路径」的白名单闸门（validatedPaths），加路径参数会打开任意文件读取面`
  }
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
}

console.log(`已登记免对话框动作：${changed} 个；保留对话框专用：${DELIBERATELY_DIALOG_ONLY.length} 个`)
