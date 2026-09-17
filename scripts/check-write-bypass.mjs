#!/usr/bin/env node
/**
 * 阶段 2 S2-04 写入口绕过检测（调用点级，AST）。
 *
 * 判定规则：
 *   1. 逐个识别「原始写调用点」（writeJson / writeFileSync / renameSync / chatData.saveMessage …）。
 *   2. 若该调用点位于某次域写入调用（writeThroughDomain / deleteThroughDomain /
 *      putWithJournal / tombstoneWithJournal）的 files 实参范围内，则视为已收口。
 *   3. 其余调用点按文件归属分类：
 *        SYNC_DOMAIN_FILES  → 同步域文件，任何未收口调用点都算违规
 *        LOCAL_ONLY_FILES   → 已确认本地不同步的数据域，允许直写（方案 §6.1）
 *        其他文件            → UNCLASSIFIED，同样算违规，迫使新增文件显式归类
 *
 * 退出码：默认 0（仅报告）；--strict 时存在违规则 exit 1。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const strict = process.argv.includes('--strict')
const verbose = process.argv.includes('--verbose')

const SCAN_DIRS = ['electron/ipc', 'electron/bridge', 'electron/services']

/**
 * 原始写调用：只列真正落盘的底层原语。
 * 域级写函数（saveSessions / writeMessages / appendMessage / saveCharacter 等）
 * 一旦收口就不再直写磁盘，因此它们内部的收口由「原语调用点」是否被 files 覆盖来判定，
 * 不需要把域名写函数本身列为原始写（否则会误报每一个调用者）。
 */
const RAW_WRITE_CALLEES = [
  'writeJson',
  'writeJsonAsync',
  'writeFileSync',
  'writeFile',
  'renameSync',
  'appendFileSync',
]

/** 合法的收口入口（files 实参即为事务内落盘内容） */
const DOMAIN_WRITE_CALLEES = [
  'writeThroughDomain',
  'deleteThroughDomain',
  'commitThroughDomain',
  'writeManyThroughDomain',
  'deleteManyThroughDomain',
  'putWithJournal',
  'tombstoneWithJournal',
  'putManyWithJournal',
  'tombstoneManyWithJournal',
  'commitWithJournal',
]

/**
 * 已废弃的「只写 journal、不包住文件写」兼容入口（S2-04 迁移期临时存在）。
 * 它们会让检测看起来通过、实际却是假事务，因此一旦出现即计为违规。
 * 全部调用点改完后这些函数连同 bridgeJournal.ts 一并删除。
 */
const DEPRECATED_SHIM_CALLEES = [
  'journalPutIfEnabled',
  'journalDeleteIfEnabled',
  'bridgeJournalPut',
  'bridgeJournalDelete',
]

/**
 * 显式豁免标记：调用点所在行或紧邻上一行含 `sync-bypass-ok: <理由>` 时，
 * 该调用点记为「已声明」，不计入违规，但会在报告中单独列出以便审计。
 * 只允许用于不改变业务数据语义的操作（如目录级回收站改名）。
 */
const BYPASS_MARKER = 'sync-bypass-ok'

/**
 * 同步域归属文件：任何未收口写调用点都是阶段 2 违规。
 * 覆盖方案 §2 S2-04 的六个子项（settings/persona/regex/quickReply、
 * preset/lorebook、character/媒体、session/message/memory、group、usage/mcp）
 * 以及 Bridge 与 services 层的后台写入口。
 */
const SYNC_DOMAIN_FILES = [
  'electron/ipc/settings.ts',
  'electron/ipc/persona.ts',
  'electron/ipc/regex.ts',
  'electron/ipc/quickReply.ts',
  'electron/ipc/preset.ts',
  'electron/ipc/lorebook.ts',
  'electron/ipc/character.ts',
  'electron/ipc/chat.ts',
  'electron/ipc/chatTasks.ts',
  'electron/ipc/group.ts',
  'electron/ipc/usage.ts',
  'electron/ipc/mcp.ts',
  'electron/bridge/chatService.ts',
  'electron/bridge/routes.ts',
  'electron/bridge/dialogueDirections.ts',
  'electron/services/usage.ts',
  'electron/services/charCard.ts',
  'electron/services/lorebookDocumentStore.ts',
  'electron/services/lorebookMappingTemplates.ts',
  'electron/services/backup.ts',
]

/**
 * 已确认「本地但不同步」的数据域（方案 §6.1）：
 * 连接/凭据/日志/本地模型/向量索引/诊断/更新器等，允许原样直写。
 */
const LOCAL_ONLY_FILES = [
  'electron/bridge/auth.ts',
  'electron/bridge/identity.ts',
  'electron/bridge/index.ts',
  'electron/ipc/announcement.ts',
  'electron/ipc/embedding.ts',
  'electron/ipc/file.ts',
  'electron/ipc/imageGen.ts',
  'electron/ipc/tts.ts',
  'electron/services/logger.ts',
  'electron/services/localModels/manager.ts',
  'electron/services/localModels/packageImport.ts',
  'electron/services/safeStorage.ts',
  'electron/services/storage.ts',
  'electron/services/vectorStore.ts',
  'electron/services/generationObservation.ts',
  'electron/services/migration.ts',
  'electron/services/settingsChangeBus.ts',
  'electron/services/filePersistence.ts',
  'electron/services/sessionSync.ts',
  'electron/mcp/manager.ts',
]

function walk(dir) {
  const out = []
  const stack = [dir]
  while (stack.length) {
    const d = stack.pop()
    let entries
    try {
      entries = readdirSync(d)
    } catch {
      continue
    }
    for (const name of entries) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) {
        if (name === '__tests__' || name === 'node_modules') continue
        stack.push(p)
      } else if (name.endsWith('.ts')) {
        out.push(p)
      }
    }
  }
  return out
}

/** 取调用表达式的完整名字，如 chatData.saveMessage / writeJson */
function calleeName(expr) {
  if (ts.isIdentifier(expr)) return expr.text
  if (ts.isPropertyAccessExpression(expr)) {
    const left = calleeName(expr.expression)
    return left ? `${left}.${expr.name.text}` : expr.name.text
  }
  return ''
}

function collectFile(filePath, relPath) {
  const text = readFileSync(filePath, 'utf8')
  const source = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

  const coveredRanges = []
  const writeSites = []
  const shimSites = []
  const lines = text.split(/\r?\n/)

  function visit(node) {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression)
      const short = name.includes('.') ? name.split('.').pop() : name

      if (DEPRECATED_SHIM_CALLEES.includes(name) || DEPRECATED_SHIM_CALLEES.includes(short)) {
        const pos = node.getStart(source)
        const { line } = source.getLineAndCharacterOfPosition(pos)
        // 定义处（function 声明）不算调用点
        const parent = node.parent
        const isDefinition =
          parent && (ts.isFunctionDeclaration(parent) || ts.isVariableDeclaration(parent))
        if (!isDefinition) shimSites.push({ line: line + 1, name })
      }

      if (DOMAIN_WRITE_CALLEES.includes(short) || DOMAIN_WRITE_CALLEES.includes(name)) {
        // files 实参（对象字面量的 files 属性，或整个实参）范围为已收口区域
        for (const arg of node.arguments) {
          if (ts.isObjectLiteralExpression(arg)) {
            const prop = arg.properties.find(
              (p) => ts.isPropertyAssignment(p) && p.name && p.name.getText(source) === 'files',
            )
            if (prop) {
              coveredRanges.push([prop.initializer.getStart(source), prop.initializer.getEnd()])
              continue
            }
          }
          coveredRanges.push([arg.getStart(source), arg.getEnd()])
        }
      } else if (RAW_WRITE_CALLEES.includes(name) || RAW_WRITE_CALLEES.includes(short)) {
        const pos = node.getStart(source)
        const { line } = source.getLineAndCharacterOfPosition(pos)
        const lineText = lines[line] ?? ''
        const prevText = line > 0 ? (lines[line - 1] ?? '') : ''
        const acknowledged = lineText.includes(BYPASS_MARKER) || prevText.includes(BYPASS_MARKER)
        writeSites.push({ line: line + 1, name, pos, acknowledged })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)

  const uncovered = writeSites.filter(
    (site) => !coveredRanges.some(([start, end]) => site.pos >= start && site.pos < end),
  )
  return {
    relPath,
    uncovered: uncovered.filter((s) => !s.acknowledged),
    acknowledged: uncovered.filter((s) => s.acknowledged),
    shimSites,
    covered: writeSites.length - uncovered.length,
  }
}

const files = []
for (const dir of SCAN_DIRS) {
  for (const abs of walk(join(root, dir))) {
    files.push({ abs, rel: abs.slice(root.length + 1).replace(/\\/g, '/') })
  }
}

const violations = []
const localOnly = []
const clean = []
const acknowledged = []

for (const { abs, rel } of files) {
  const { uncovered, acknowledged: ack, shimSites, covered } = collectFile(abs, rel)
  if (ack.length) acknowledged.push({ rel, sites: ack })
  const isSync = SYNC_DOMAIN_FILES.includes(rel)
  const isLocal = LOCAL_ONLY_FILES.includes(rel)
  if (isSync) {
    if (uncovered.length || shimSites.length) {
      violations.push({ rel, kind: 'SYNC_DOMAIN', sites: [...uncovered, ...shimSites.map((s) => ({ ...s, name: `${s.name} (deprecated shim)` }))] })
    } else {
      clean.push({ rel, covered })
    }
  } else if (isLocal) {
    if (uncovered.length) localOnly.push({ rel, sites: uncovered })
  } else if (uncovered.length) {
    violations.push({ rel, kind: 'UNCLASSIFIED', sites: uncovered })
  }
}

console.log('check-write-bypass (调用点级 / AST)')
console.log(` sync-domain files=${SYNC_DOMAIN_FILES.length}  fully-journaled=${clean.length}`)

const totalCovered = clean.reduce((sum, f) => sum + f.covered, 0)
console.log(` journaled write call-sites=${totalCovered}`)
for (const f of clean) {
  if (verbose) console.log(`  OK ${f.rel} (${f.covered})`)
}
console.log(` local-only files with direct writes=${localOnly.length}`)
if (verbose) {
  for (const f of localOnly) console.log(`  LOCAL ${f.rel} sites=${f.sites.length}`)
}

console.log(` acknowledged (sync-bypass-ok) sites=${acknowledged.reduce((n, f) => n + f.sites.length, 0)}`)
for (const f of acknowledged) {
  for (const s of f.sites) console.log(`  ACK ${f.rel} L${s.line} ${s.name}`)
}

for (const v of violations) {
  console.log(` VIOLATION [${v.kind}] ${v.rel}`)
  for (const s of v.sites) console.log(`    L${s.line} ${s.name}`)
}
const missingSync = SYNC_DOMAIN_FILES.filter((f) => !files.some((x) => x.rel === f))
for (const m of missingSync) console.log(` VIOLATION [MISSING_SYNC_FILE] ${m}`)
const staleLocal = LOCAL_ONLY_FILES.filter((f) => !files.some((x) => x.rel === f))
for (const s of staleLocal) console.log(` NOTE [LOCAL_FILE_GONE] ${s}`)

console.log(` violations=${violations.length + missingSync.length}`)

if (strict && (violations.length || missingSync.length)) {
  console.error('strict: 仍有同步域写入口未收口（或新增文件未归类）')
  process.exit(1)
}
