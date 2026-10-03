/**
 * Backup V2 服务 — 全量备份与恢复（zip + manifest + 哈希校验）
 *
 * 覆盖审计 F-01 要求：settings / characters(+头像) / lorebooks / presets /
 * personas / regex / quickReplies / mcp / usage / chats / groups 全量。
 * 敏感信息（apiKey 等）默认不导出，敏感文件在结果页明示。
 *
 * 安全（P0-A / P0-B）：
 * - 恢复侧所有条目路径统一经 safePath + 根目录边界二次断言，拒绝绝对路径、
 *   盘符、反斜杠变体与 `.` / `..` 段；
 * - manifest 与 zip 条目双向一致性校验：任一条目缺哈希记录、或 manifest 记录的
 *   条目在包内缺失，均整包拒绝；
 * - 写入前先完成全部校验与快照，失败时回滚全部被覆盖文件并删除本次新建文件；
 * - 导出侧剥离 semanticTrigger.apiKey，并对 MCP env 敏感值脱敏。
 */

import { app } from 'electron'
import { join, dirname, resolve, sep } from 'node:path'
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, statSync, rmSync, mkdtempSync, copyFileSync, unlinkSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import AdmZip from 'adm-zip'
import { DIRS, writeJson } from './storage'
import { createLogger } from './logger'
import { safeId, safePath } from '../utils/pathGuard'
import { publicFeatureHistory, prepareFeatureBackupRestore } from './featureBackup'
import { prepareFeatureDataRestore } from './featureTaskLifecycle'
import type { Settings } from '../../shared/types'
import { saveCredential } from './safeStorage'
import { hashSpatialValue, validateSpatialPackage, validateSpatialScope, isGroupScope, spatialRuntimeId, type SpatialOwnerScope } from './spatialRepository'
import type { SpatialAiSession } from '../../shared/spatial-ai'
import type { ChatSession, GroupSession, GroupChat } from '../../shared/types'
// eslint-disable-next-line no-restricted-imports
import type { SpatialCoreState } from '@qingyu/spatial-core'

const log = createLogger('backup')

export interface BackupManifest {
  version: 2
  appVersion: string
  createdAt: number
  counts: Record<string, number>
  hashes: Record<string, string> // zipPath -> sha256 hex
  excluded: string[] // 未包含项（敏感/可重建）
  totalBytes: number
}

const EXCLUDED_ITEMS = [
  'API Key / 凭据（safeStorage）',
  'MCP 环境变量敏感值（KEY/TOKEN/SECRET/PASSWORD 导出时置空）',
  '设备配对凭据',
  '向量索引（可重建）',
]

// 本地 stripSecrets（避免与 electron/ipc/settings 循环依赖）
type SecretItem = { id: string; apiKey?: string }
type SecretListGetter = (s: Settings) => SecretItem[] | undefined
const SECRET_COLLECTIONS: Array<{ get: SecretListGetter; prefix: string }> = [
  { get: (s) => s.connectionProfiles, prefix: 'profile' },
  { get: (s) => s.ttsModels, prefix: 'tts' },
  { get: (s) => s.imageGenModels, prefix: 'imagegen' },
  { get: (s) => s.visionModels, prefix: 'vision' },
]
/** 单例结构中的敏感字段（非数组集合）：本轮纳入 semanticTrigger.apiKey（P0-B） */
const SECRET_SINGLETONS: Array<{ get: (s: Settings) => { apiKey?: string } | undefined; key: string }> = [
  { get: (s) => s.semanticTrigger, key: 'semanticTrigger' },
]

function stripSecretsLocal(settings: Settings, persist: boolean): void {
  for (const { get, prefix } of SECRET_COLLECTIONS) {
    for (const item of get(settings) ?? []) {
      if (typeof item.apiKey === 'string' && item.apiKey.length > 0) {
        if (persist) saveCredential(`${prefix}-${item.id}`, item.apiKey)
      }
      delete (item as Record<string, unknown>).apiKey
    }
  }
  for (const { get, key } of SECRET_SINGLETONS) {
    const item = get(settings)
    if (!item) continue
    if (typeof item.apiKey === 'string' && item.apiKey.length > 0) {
      if (persist) saveCredential(key, item.apiKey)
    }
    delete (item as Record<string, unknown>).apiKey
  }
}

/** MCP env 敏感键名：命中即不导出明文值 */
const SENSITIVE_ENV_KEY_RE = /KEY|TOKEN|SECRET|PASSWORD/i

/**
 * mcp-servers.json 导出前脱敏（P0-B）：
 * - env 中键名命中 SENSITIVE_ENV_KEY_RE 的值置空（保留键名，提示用户回填）；
 * - URL 内嵌的 userinfo（https://user:pass@host）打码。
 * 解析失败时原样返回，避免把可读配置变成坏文件。
 */
function sanitizeMcpServers(raw: Buffer): Buffer {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.toString('utf-8'))
  } catch {
    return raw
  }
  if (!Array.isArray(parsed)) return raw

  for (const item of parsed as Array<Record<string, unknown>>) {
    if (!item || typeof item !== 'object') continue
    const env = item.env
    if (env && typeof env === 'object' && !Array.isArray(env)) {
      for (const key of Object.keys(env as Record<string, unknown>)) {
        const value = (env as Record<string, unknown>)[key]
        if (SENSITIVE_ENV_KEY_RE.test(key) && typeof value === 'string' && value.length > 0) {
          ;(env as Record<string, unknown>)[key] = ''
        }
      }
    }
    if (typeof item.url === 'string' && item.url.length > 0) {
      try {
        const url = new URL(item.url)
        if (url.username || url.password) {
          url.username = url.username ? '***' : ''
          url.password = url.password ? '***' : ''
          item.url = url.toString()
        }
      } catch { /* 非标准 URL 原样保留 */ }
    }
  }
  return Buffer.from(JSON.stringify(parsed, null, 2), 'utf-8')
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/** 日志/报错中的路径截断，避免超长条目名污染输出 */
function clipPath(zipPath: string): string {
  return zipPath.length > 120 ? `${zipPath.substring(0, 120)}…` : zipPath
}

function listFilesRecursive(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()!
    let entries: Array<import('node:fs').Dirent>
    try { entries = readdirSync(cur, { withFileTypes: true }) } catch { continue }
    for (const ent of entries) {
      const full = join(cur, ent.name)
      if (ent.isDirectory()) stack.push(full)
      else out.push(full)
    }
  }
  return out
}

/** 收集需要备份的条目：{ fsPath, zipPath } */
function collectEntries(): Array<{ fsPath: string; zipPath: string }> {
  const entries: Array<{ fsPath: string; zipPath: string }> = []

  // settings.json（剥离 apiKey 后）
  const settingsPath = join(DIRS.config(), 'settings.json')
  if (existsSync(settingsPath)) {
    entries.push({ fsPath: settingsPath, zipPath: 'config/settings.json' })
  }

  // config 单文件
  const configFiles: Array<[string, string]> = [
    [join(DIRS.config(), 'personas.json'), 'config/personas.json'],
    [join(DIRS.config(), 'regex', 'rules.json'), 'config/regex/rules.json'],
    [join(DIRS.config(), 'quickReplies.json'), 'config/quickReplies.json'],
    [join(DIRS.config(), 'mcp-servers.json'), 'config/mcp-servers.json'],
    [join(DIRS.config(), 'usage.json'), 'config/usage.json'],
  ]
  for (const [fsPath, zipPath] of configFiles) {
    if (existsSync(fsPath)) entries.push({ fsPath, zipPath })
  }

  // characters: json + 头像/封面图片
  if (existsSync(DIRS.characters())) {
    for (const f of readdirSync(DIRS.characters())) {
      if (f.endsWith('.json') || /\.(png|jpg|jpeg|webp|gif)$/i.test(f)) {
        entries.push({ fsPath: join(DIRS.characters(), f), zipPath: `characters/${f}` })
      }
    }
  }

  // lorebooks
  if (existsSync(DIRS.lorebooks())) {
    for (const f of readdirSync(DIRS.lorebooks()).filter((x: string) => x.endsWith('.json'))) {
      entries.push({ fsPath: join(DIRS.lorebooks(), f), zipPath: `lorebooks/${f}` })
    }
  }

  // presets
  if (existsSync(DIRS.presets())) {
    for (const f of readdirSync(DIRS.presets()).filter((x: string) => x.endsWith('.json'))) {
      entries.push({ fsPath: join(DIRS.presets(), f), zipPath: `presets/${f}` })
    }
  }

  // chats — 递归
  if (existsSync(DIRS.chats())) {
    for (const abs of listFilesRecursive(DIRS.chats())) {
      const rel = abs.substring(DIRS.chats().length + 1).replace(/\\/g, '/')
      entries.push({ fsPath: abs, zipPath: `chats/${rel}` })
    }
  }

  // groups — 递归
  if (existsSync(DIRS.groups())) {
    for (const abs of listFilesRecursive(DIRS.groups())) {
      const rel = abs.substring(DIRS.groups().length + 1).replace(/\\/g, '/')
      // 跳过临时删除目录
      if (rel.startsWith('.deleting-')) continue
      entries.push({ fsPath: abs, zipPath: `groups/${rel}` })
    }
  }

  // spatial — 世界定义和会话位置同属用户创作数据。
  if (existsSync(DIRS.spatial())) {
    for (const abs of listFilesRecursive(DIRS.spatial())) {
      const rel = abs.substring(DIRS.spatial().length + 1).replace(/\\/g, '/')
      if (rel.endsWith('.json')) entries.push({ fsPath: abs, zipPath: `spatial/${rel}` })
    }
  }

  return entries
}

export interface ExportResult {
  path: string
  counts: Record<string, number>
  totalBytes: number
  excluded: string[]
}

/** 创建 Backup V2 zip 到指定路径 */
export function createBackupV2(destPath: string): ExportResult {
  const entries = collectEntries()
  const zip = new AdmZip()

  const counts: Record<string, number> = {
    characters: 0, lorebooks: 0, presets: 0, chats: 0, groups: 0, spatial: 0, personas: 0, regex: 0, quickReplies: 0, mcp: 0, usage: 0, settings: 0,
  }
  const hashes: Record<string, string> = {}
  let totalBytes = 0

  // 统计辅助：按 zipPath 前缀计数
  const inc = (prefix: string) => {
    if (prefix.startsWith('characters/')) counts.characters++
    else if (prefix.startsWith('lorebooks/')) counts.lorebooks++
    else if (prefix.startsWith('presets/')) counts.presets++
    else if (prefix.startsWith('chats/')) counts.chats++
    else if (prefix.startsWith('groups/')) counts.groups++
    else if (prefix.startsWith('spatial/')) counts.spatial++
    else if (prefix === 'config/personas.json') counts.personas = 1
    else if (prefix === 'config/regex/rules.json') counts.regex = 1
    else if (prefix === 'config/quickReplies.json') counts.quickReplies = 1
    else if (prefix === 'config/mcp-servers.json') counts.mcp = 1
    else if (prefix === 'config/usage.json') counts.usage = 1
    else if (prefix === 'config/settings.json') counts.settings = 1
  }

  for (const { fsPath, zipPath } of entries) {
    try {
      let buf = readFileSync(fsPath)
      // settings.json 需剥离 apiKey（不落敏感信息）
      if (zipPath === 'config/settings.json') {
        try {
          const parsed = JSON.parse(buf.toString('utf-8')) as Settings & Record<string, unknown>
          // 深拷贝后剥离
          const copy = JSON.parse(JSON.stringify(parsed)) as Settings
          stripSecretsLocal(copy, false)
          buf = Buffer.from(JSON.stringify(copy, null, 2), 'utf-8')
        } catch { /* 解析失败则原样打包 */ }
      } else if (zipPath === 'config/mcp-servers.json') {
        // MCP env 敏感值与 URL 内嵌凭据不得原样入包（P0-B）
        buf = sanitizeMcpServers(buf)
      } else if (/^spatial\/ai-sessions\/[^/]+\.json$/.test(zipPath)) {
        buf = publicFeatureHistory(buf)
      }
      hashes[zipPath] = sha256(buf)
      totalBytes += buf.length
      zip.addFile(zipPath, buf)
      inc(zipPath)
    } catch (e) {
      log.warn('备份跳过不可读文件', { fsPath, error: (e as Error).message })
    }
  }

  // 清理 0 计数的 key
  for (const k of Object.keys(counts)) if (counts[k] === 0) delete counts[k]

  const manifest: BackupManifest = {
    version: 2,
    appVersion: (() => { try { return app.getVersion() } catch { return '0.0.0' } })(),
    createdAt: Date.now(),
    counts,
    hashes,
    excluded: EXCLUDED_ITEMS,
    totalBytes,
  }
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8'))

  mkdirSync(dirname(destPath), { recursive: true })
  zip.writeZip(destPath)

  // 更新 manifest.totalBytes 为 zip 实际大小（更直观）
  try {
    const st = statSync(destPath)
    manifest.totalBytes = st.size
    // 重写 manifest（adm-zip 已写入，追加更新不影响校验；此处仅日志用）
  } catch { /* ignore */ }

  log.info('Backup V2 已导出', { path: destPath, counts, totalBytes })
  return { path: destPath, counts, totalBytes, excluded: EXCLUDED_ITEMS }
}

// ===================== 恢复侧路径安全（P0-A） =====================

/** 恢复目标：config 下固定文件（目标路径不由包内内容决定） */
const RESTORE_CONFIG_FILES: Record<string, () => string> = {
  'config/settings.json': () => join(DIRS.config(), 'settings.json'),
  'config/personas.json': () => join(DIRS.config(), 'personas.json'),
  'config/regex/rules.json': () => join(DIRS.config(), 'regex', 'rules.json'),
  'config/quickReplies.json': () => join(DIRS.config(), 'quickReplies.json'),
  'config/mcp-servers.json': () => join(DIRS.config(), 'mcp-servers.json'),
  'config/usage.json': () => join(DIRS.config(), 'usage.json'),
}

/** 恢复目标：目录前缀 -> 目标目录（相对部分必须通过 safeEntrySegments） */
const RESTORE_DIR_PREFIXES: Array<{ prefix: string; dir: () => string }> = [
  { prefix: 'characters/', dir: DIRS.characters },
  { prefix: 'lorebooks/', dir: DIRS.lorebooks },
  { prefix: 'presets/', dir: DIRS.presets },
  { prefix: 'chats/', dir: DIRS.chats },
  { prefix: 'groups/', dir: DIRS.groups },
  { prefix: 'spatial/', dir: DIRS.spatial },
]

/**
 * 校验条目相对路径并拆分为段：
 * 拒绝反斜杠（Windows 分隔符变体）、盘符、绝对路径、空段、`.` 与 `..` 段。
 */
function safeEntrySegments(relPath: string, zipPath: string): string[] {
  if (relPath.includes('\\')) {
    throw new Error(`备份条目路径非法（含反斜杠）: ${clipPath(zipPath)}`)
  }
  if (/^[a-zA-Z]:/.test(relPath) || relPath.startsWith('/')) {
    throw new Error(`备份条目路径非法（绝对路径/盘符）: ${clipPath(zipPath)}`)
  }
  const segments = relPath.split('/')
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') {
      throw new Error(`备份条目路径非法（越权路径段 "${seg}"）: ${clipPath(zipPath)}`)
    }
    if (seg.includes(':')) {
      throw new Error(`备份条目路径非法（含冒号）: ${clipPath(zipPath)}`)
    }
  }
  return segments
}

/** 根目录边界二次断言：不依赖前置校验，resolve 后必须仍在目标根目录内 */
function assertWithinRoot(rootDir: string, dest: string, zipPath: string): void {
  const rootAbs = resolve(rootDir)
  const destAbs = resolve(dest)
  if (destAbs !== rootAbs && !destAbs.startsWith(rootAbs + sep)) {
    throw new Error(`备份条目越出目标目录，已拒绝: ${clipPath(zipPath)}`)
  }
}

/** 解析条目落盘路径；未知前缀整包拒绝（合法备份只含已知域） */
function resolveEntryDest(zipPath: string): string {
  const fixedDest = RESTORE_CONFIG_FILES[zipPath]
  if (fixedDest) {
    const dest = fixedDest()
    assertWithinRoot(DIRS.config(), dest, zipPath)
    return dest
  }
  for (const { prefix, dir } of RESTORE_DIR_PREFIXES) {
    if (!zipPath.startsWith(prefix)) continue
    const segments = safeEntrySegments(zipPath.substring(prefix.length), zipPath)
    const root = dir()
    const dest = safePath(root, ...segments)
    assertWithinRoot(root, dest, zipPath)
    return dest
  }
  // 绝对路径 / 盘符 / 反斜杠在归类为"未知条目"前先按路径非法拒绝，便于审计区分
  if (zipPath.startsWith('/') || zipPath.includes('\\') || /^[a-zA-Z]:/.test(zipPath)) {
    throw new Error(`备份条目路径非法: ${clipPath(zipPath)}`)
  }
  throw new Error(`备份包含未知条目，已拒绝: ${clipPath(zipPath)}`)
}

/** 顶层数据文件（characters/、lorebooks/、presets/ 直属 .json）文件名即 id，强校验 */
function validateTopLevelId(zipPath: string): void {
  const segments = zipPath.split('/')
  if (segments.length !== 2) return
  const [topDir, file] = segments
  if (topDir !== 'characters' && topDir !== 'lorebooks' && topDir !== 'presets') return
  if (!file.endsWith('.json')) return
  safeId(file.substring(0, file.length - '.json'.length))
}

/** 先按事务完成后的逻辑状态校验归属，允许断电时的合法 before/after 文件组合。 */
function validateSpatialBackup(files: Array<{ zipPath: string; data: Buffer }>): void {
  if (!files.some(file => file.zipPath.startsWith('spatial/'))) return
  const values = new Map<string, unknown>()
  for (const file of files.filter(file => file.zipPath.startsWith('spatial/') || (/^(chats|groups)\/[^/]+\/sessions\.json$/.test(file.zipPath) || file.zipPath === 'groups/index.json'))) {
    try { values.set(file.zipPath, JSON.parse(file.data.toString('utf8'))) } catch { throw new Error(`空间备份 JSON 无效：${clipPath(file.zipPath)}`) }
  }
  for (const [path, value] of [...values].filter(([name]) => name.startsWith('spatial/transactions/')).sort(([a],[b]) => a.localeCompare(b))) {
    const tx = value as { schemaVersion: number; id: string; worldId: string; scope: SpatialOwnerScope; aiSessionId?: string;
      binding?: { before: { worldId: string | null; runtimeId: string | null }; after: { worldId: string | null; runtimeId: string | null } };
      files: Array<{ kind: string; beforeHash: string | null; afterHash: string; after: unknown }> }
    if (!tx || tx.schemaVersion !== 1 || !tx.scope || !Array.isArray(tx.files) || tx.files.length < 2 || tx.files.length > 4 || new Set(tx.files.map(file => file.kind)).size !== tx.files.length) throw new Error('空间备份事务无效')
    validateSpatialScope(tx.scope)
    const group = isGroupScope(tx.scope)
    if (group && (tx.files.length !== (tx.aiSessionId ? 4 : 3) || !['world', 'runtime', 'state', ...(tx.aiSessionId ? ['ai'] : [])].every(kind => tx.files.some(file => file.kind === kind)))) throw new Error('空间备份群聊事务缺少世界、位置或提交记录')
    if (group && tx.aiSessionId && isGroupScope(tx.scope)) {
      const ai = tx.files.find(file => file.kind === 'ai')?.after as import('../../shared/spatial-ai').SpatialGroupAiSession
      if (ai?.id !== tx.aiSessionId || ai.scope?.kind !== 'group' || ai.scope.groupId !== tx.scope.groupId || ai.scope.sessionId !== tx.scope.sessionId || ai.scope.worldId !== tx.worldId) throw new Error('空间备份群聊助手事务归属无效')
    }
    const worldId = safeId(tx.worldId), ownerId = safeId(isGroupScope(tx.scope) ? tx.scope.groupId : tx.scope.characterId), sessionId = safeId(tx.scope.sessionId)
    const runtimeRoot = group ? 'group-runtimes' : 'runtimes', stateRoot = group ? 'group-session-state' : 'session-state'
    if (path !== `spatial/transactions/${safeId(tx.id)}.json`) throw new Error('空间备份事务 ID 不匹配')
    for (const file of tx.files) {
      const target = file.kind === 'world' ? `spatial/worlds/${worldId}.json` : file.kind === 'runtime' ? `spatial/${runtimeRoot}/${ownerId}/${sessionId}.json`
        : file.kind === 'state' ? `spatial/${stateRoot}/${ownerId}/${sessionId}.json` : file.kind === 'ai' && tx.aiSessionId ? `spatial/ai-sessions/${safeId(tx.aiSessionId)}.json` : null
      if (!target || hashSpatialValue(file.after) !== file.afterHash) throw new Error('空间备份事务内容无效')
      const current = values.get(target), hash = current === undefined ? null : hashSpatialValue(current)
      if (hash !== file.beforeHash && hash !== file.afterHash) throw new Error('空间备份事务与文件不匹配')
      values.set(target, file.after)
    }
    if (tx.binding) {
      const sessions = values.get(`${group ? 'groups' : 'chats'}/${ownerId}/sessions.json`) as Array<ChatSession | GroupSession> | undefined
      const session = Array.isArray(sessions) ? sessions.find(item => item.id === sessionId) : null
      if (!session) throw new Error('空间备份事务所属会话缺失')
      const current = { worldId: session.spatialWorldId ?? null, runtimeId: session.spatialRuntimeId ?? null }
      if (![hashSpatialValue(tx.binding.before),hashSpatialValue(tx.binding.after)].includes(hashSpatialValue(current))) throw new Error('空间备份事务绑定不匹配')
      session.spatialWorldId = tx.binding.after.worldId; session.spatialRuntimeId = tx.binding.after.runtimeId
    }
  }
  const sessions = new Map<string, ChatSession>()
  for (const [path, value] of values) if (/^chats\/[^/]+\/sessions\.json$/.test(path)) {
    if (!Array.isArray(value)) throw new Error('空间备份单聊索引无效')
    const characterId = path.split('/')[1]
    for (const session of value as ChatSession[]) {
      if (session.characterId && session.characterId !== characterId) throw new Error('空间备份单聊角色不匹配')
      sessions.set(`${characterId}/${safeId(session.id)}`, session)
    }
  }
  for (const [key, session] of sessions) {
    if (session.spatialWorldId) {
      const world = values.get(`spatial/worlds/${safeId(session.spatialWorldId)}.json`) as SpatialCoreState['world'] | undefined
      const runtime = values.get(`spatial/runtimes/${key}.json`) as SpatialCoreState['runtime'] | undefined
      const state = values.get(`spatial/session-state/${key}.json`) as { worldId: string; runtimeId: string } | undefined
      if (!world || !runtime || world.id !== session.spatialWorldId || runtime.worldId !== world.id || runtime.runtimeId !== (session.spatialRuntimeId ?? `single_${session.id}`)) throw new Error('空间备份地图或会话位置绑定不匹配')
      validateSpatialPackage({ world, runtime })
      if (state && (state.worldId !== world.id || state.runtimeId !== runtime.runtimeId)) throw new Error('空间备份提交记录与绑定不匹配')
    }
    if (session.spatialAiSessionId && !values.has(`spatial/ai-sessions/${safeId(session.spatialAiSessionId)}.json`)) throw new Error('空间备份缺少当前画板助手记录')
  }
  const groupSessions = new Map<string, GroupSession>()
  const groups = values.get('groups/index.json') as GroupChat[] | undefined
  for (const [path, value] of values) if (/^groups\/[^/]+\/sessions\.json$/.test(path)) {
    if (!Array.isArray(value)) throw new Error('空间备份群聊会话索引无效')
    const groupId = safeId(path.split('/')[1])
    for (const session of value as GroupSession[]) {
      if (!session.spatialWorldId && !session.spatialRuntimeId && !session.spatialAiSessionId) continue
      if (session.groupId !== groupId || !Array.isArray(groups) || !groups.some(group => group.id === groupId && Array.isArray(group.memberIds))) throw new Error('空间备份画板所属群聊缺失或不匹配')
      const key = `${groupId}/${safeId(session.id)}`
      if (groupSessions.has(key)) throw new Error('空间备份群聊会话重复')
      groupSessions.set(key, session)
      if (session.spatialAiSessionId && !values.has(`spatial/ai-sessions/${safeId(session.spatialAiSessionId)}.json`)) throw new Error('空间备份缺少当前群聊画板助手记录')
      if (!session.spatialWorldId && !session.spatialRuntimeId) continue
      const runtimeId = spatialRuntimeId({ kind: 'group', groupId, sessionId: session.id })
      const world = session.spatialWorldId ? values.get(`spatial/worlds/${safeId(session.spatialWorldId)}.json`) as SpatialCoreState['world'] | undefined : undefined
      const runtime = values.get(`spatial/group-runtimes/${key}.json`) as SpatialCoreState['runtime'] | undefined
      const state = values.get(`spatial/group-session-state/${key}.json`) as { schemaVersion: number; worldId: string; runtimeId: string; bindingEpoch: string; commits: unknown } | undefined
      if (!world || !runtime || world.id !== session.spatialWorldId || session.spatialRuntimeId !== runtimeId || runtime.runtimeId !== runtimeId || runtime.worldId !== world.id) throw new Error('空间备份群聊地图或位置绑定不匹配')
      validateSpatialPackage({ world, runtime })
      if (!state || state.schemaVersion !== 1 || state.worldId !== world.id || state.runtimeId !== runtimeId || typeof state.bindingEpoch !== 'string' || !state.bindingEpoch || !state.commits || typeof state.commits !== 'object' || Array.isArray(state.commits)) throw new Error('空间备份群聊提交记录缺失或绑定不匹配')
    }
  }
  for (const path of values.keys()) if (path.startsWith('spatial/group-runtimes/') || path.startsWith('spatial/group-session-state/')) {
    const match = /^spatial\/(group-runtimes|group-session-state)\/([^/]+)\/([^/]+)\.json$/.exec(path)
    if (!match || !groupSessions.has(`${safeId(match[2])}/${safeId(match[3])}`)) throw new Error('空间备份群聊位置或提交记录没有所属会话')
  }
  for (const [path, value] of values) if (path.startsWith('spatial/ai-sessions/')) {
    const groupAi = value as import('../../shared/spatial-ai').SpatialGroupAiSession
    if (groupAi?.scope?.kind === 'group') {
      if (groupAi.schemaVersion !== 1 || !Array.isArray(groupAi.messages) || !Array.isArray(groupAi.proposals) || !Array.isArray(groupAi.tasks) || path !== `spatial/ai-sessions/${safeId(groupAi.id)}.json`) throw new Error('空间备份群聊助手记录无效')
      const key = `${safeId(groupAi.scope.groupId)}/${safeId(groupAi.scope.sessionId)}`, session = groupSessions.get(key)
      if (!session) throw new Error('空间备份助手所属群聊缺失')
      if (groupAi.scope.worldId && !values.has(`spatial/worlds/${safeId(groupAi.scope.worldId)}.json`)) throw new Error('空间备份群聊助手所属地图缺失')
      if (groupAi.groupDialogueBatches !== undefined && !Array.isArray(groupAi.groupDialogueBatches)) throw new Error('空间备份群聊剧情批次无效')
      const batchIds = new Set<string>(), generationIds = new Set<string>()
      for (const batch of groupAi.groupDialogueBatches ?? []) {
        if (!batch || !Number.isSafeInteger(batch.sequence) || batch.sequence < 1 || typeof batch.closed !== 'boolean' || !['normal','regenerate'].includes(batch.kind) || !['mention','polling','free'].includes(batch.mode) || !['immersive','omniscient'].includes(batch.narrativeMode) || !Array.isArray(batch.memberIds) || !Array.isArray(batch.generations) || batch.generations.length > 200 || typeof batch.contextFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(batch.contextFingerprint) || !batch.snapshot?.version) throw new Error('空间备份群聊剧情批次无效')
        safeId(batch.id); if (batchIds.has(batch.id)) throw new Error('空间备份群聊剧情批次重复'); batchIds.add(batch.id)
        batch.memberIds.forEach(safeId)
        if (batch.snapshot.version.worldId !== groupAi.scope.worldId || batch.snapshot.version.runtimeId !== spatialRuntimeId({kind:'group',groupId:groupAi.scope.groupId,sessionId:groupAi.scope.sessionId})) throw new Error('空间备份群聊剧情快照归属无效')
        const capturedCore = batch.snapshot as unknown as SpatialCoreState
        validateSpatialPackage(capturedCore)
        if (capturedCore.world.id !== batch.snapshot.version.worldId || capturedCore.runtime.runtimeId !== batch.snapshot.version.runtimeId || capturedCore.runtime.revision !== batch.snapshot.version.runtimeRevision) throw new Error('空间备份群聊剧情快照版本无效')
        for (const generation of batch.generations) {
          safeId(generation.id); if (generationIds.has(generation.id) || !['awaiting_body','registered','ignored'].includes(generation.state) || !Array.isArray(generation.messageIds) || !Array.isArray(generation.bodyHashes) || generation.messageIds.length !== generation.bodyHashes.length || generation.messageIds.length > 200) throw new Error('空间备份群聊剧情检查点无效')
          generationIds.add(generation.id); generation.messageIds.forEach(safeId)
          if (generation.state === 'registered' && !generation.messageIds.length) throw new Error('空间备份群聊完整正文检查点缺失')
          if (generation.bodyHashes.some(hash => typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))) throw new Error('空间备份群聊剧情正文 hash 无效')
        }
      }
      const proposalIds = new Set<string>()
      for (const proposal of groupAi.proposals) {
        safeId(proposal.id)
        if (proposalIds.has(proposal.id)) throw new Error('空间备份群聊提案重复')
        proposalIds.add(proposal.id)
        if (proposal.placeForId !== undefined) {
          safeId(proposal.placeForId)
          const original = groupAi.proposals.find(item => item.id === proposal.placeForId)
          const command = proposal.commands?.[0]
          if (proposal.mode !== 'instruction' || !original || original.mode !== 'dialogue_sync' || !proposal.dialogueId || proposal.dialogueId !== original.dialogueId || proposal.sourceFingerprint !== original.sourceFingerprint || !Array.isArray(proposal.commands) || proposal.commands.length !== 1 || !command || typeof command !== 'object' || !('type' in command) || command.type !== 'create_node') throw new Error('空间备份群聊地点创建来源不匹配')
        }
        if (proposal.mode === 'dialogue_sync' && proposal.status === 'pending' && !batchIds.has(proposal.dialogueId ?? '')) throw new Error('空间备份群聊待确认建议缺少来源批次')
      }
      if (session.spatialAiSessionId === groupAi.id) {
        const state = values.get(`spatial/group-session-state/${key}.json`) as { bindingEpoch: string } | undefined
        if (groupAi.scope.worldId !== (session.spatialWorldId ?? null) || groupAi.scope.runtimeId !== (session.spatialWorldId ? session.spatialRuntimeId ?? null : null) || groupAi.scope.bindingEpoch !== (session.spatialWorldId ? state?.bindingEpoch ?? null : null)) throw new Error('空间备份当前群聊助手与画板绑定不匹配')
      }
      continue
    }
    const ai = value as SpatialAiSession
    if (!ai || ai.schemaVersion !== 1 || !ai.scope || !Array.isArray(ai.messages) || !Array.isArray(ai.proposals) || !Array.isArray(ai.tasks) || path !== `spatial/ai-sessions/${safeId(ai.id)}.json`) throw new Error('空间备份助手记录无效')
    const key = `${safeId(ai.scope.characterId)}/${safeId(ai.scope.sessionId)}`, session = sessions.get(key)
    if (!session) throw new Error('空间备份助手所属单聊缺失')
    if (ai.scope.worldId && !values.has(`spatial/worlds/${safeId(ai.scope.worldId)}.json`)) throw new Error('空间备份助手所属地图缺失')
    if (session.spatialAiSessionId === ai.id) {
      const state = values.get(`spatial/session-state/${key}.json`) as { bindingEpoch: string } | undefined
      if (ai.scope.worldId !== (session.spatialWorldId ?? null) || ai.scope.runtimeId !== (session.spatialWorldId ? session.spatialRuntimeId ?? `single_${session.id}` : null) || ai.scope.bindingEpoch !== (session.spatialWorldId ? state?.bindingEpoch ?? 'legacy' : null)) throw new Error('空间备份当前助手与画板绑定不匹配')
    }
  }
  for (const [key, session] of sessions) if (session.spatialAiSessionId) {
    const ai = values.get(`spatial/ai-sessions/${session.spatialAiSessionId}.json`) as SpatialAiSession
    if (`${ai.scope.characterId}/${ai.scope.sessionId}` !== key) throw new Error('空间备份助手属于其他单聊')
  }
  for (const [key, session] of groupSessions) if (session.spatialAiSessionId) {
    const ai = values.get(`spatial/ai-sessions/${session.spatialAiSessionId}.json`) as import('../../shared/spatial-ai').SpatialGroupAiSession
    if (ai.scope.kind !== 'group' || `${ai.scope.groupId}/${ai.scope.sessionId}` !== key) throw new Error('空间备份助手属于其他群聊')
  }
}

/** 从 zip 恢复，返回 counts；会校验 manifest hashes 与条目路径 */
export function restoreBackupV2(zipPath: string): { counts: Record<string, number> } {
  if (!existsSync(zipPath)) throw new Error('备份文件不存在')
  const zip = new AdmZip(zipPath)
  const entries = zip.getEntries()

  const manifestEntry = entries.find(e => e.entryName === 'manifest.json')
  if (!manifestEntry) {
    throw new Error('无效备份：缺少 manifest.json（可能是旧版 JSON 备份，请用 v1 导入）')
  }
  const manifest = JSON.parse(manifestEntry.getData().toString('utf-8')) as BackupManifest
  if (manifest.version !== 2) throw new Error(`不支持的备份版本: ${manifest.version}`)
  if (!manifest.hashes || typeof manifest.hashes !== 'object' || Array.isArray(manifest.hashes)) {
    throw new Error('无效备份：manifest.hashes 缺失或格式错误')
  }

  // 双向校验：zip 任一条目必须有哈希记录，manifest 任一条记录必须在 zip 中存在
  const entryNames = new Set<string>()
  const files: Array<{ zipPath: string; data: Buffer }> = []
  for (const entry of entries) {
    if (entry.isDirectory) continue
    const name = entry.entryName
    if (entryNames.has(name)) {
      throw new Error(`备份校验失败：条目重复 ${clipPath(name)}`)
    }
    entryNames.add(name)
    if (name === 'manifest.json') continue
    const expected = manifest.hashes[name]
    if (typeof expected !== 'string' || expected.length === 0) {
      throw new Error(`备份校验失败：条目缺少哈希记录 ${clipPath(name)}`)
    }
    const data = entry.getData()
    if (sha256(data) !== expected) {
      throw new Error(`备份校验失败：${clipPath(name)} 哈希不一致（可能文件损坏）`)
    }
    files.push({ zipPath: name, data })
  }
  for (const recorded of Object.keys(manifest.hashes)) {
    if (!entryNames.has(recorded)) {
      throw new Error(`备份校验失败：manifest 记录的条目在压缩包中缺失 ${clipPath(recorded)}`)
    }
  }

  // 目标路径解析与 id 校验在写入前全部完成：任一非法即整包拒绝，不落盘
  const writes = files.map(({ zipPath: name, data }) => {
    validateTopLevelId(name)
    return { zipPath: name, data, dest: resolveEntryDest(name) }
  })
  validateSpatialBackup(files)
  prepareFeatureBackupRestore(files)
  // 哈希校验针对原包，来源处理在校验之后；落盘使用处理后的数据。
  const preparedFiles = new Map(files.map(file => [file.zipPath, file.data]))
  for (const write of writes) write.data = preparedFiles.get(write.zipPath)!

  // 写入前快照：记录被覆盖文件与本次新建文件，失败时完整回滚（P1-01）
  const snapshotDir = mkdtempSync(join(tmpdir(), 'qingyu-restore-'))
  const overwritten = new Map<string, string>()
  const created: string[] = []
  const obsoleteSpatial = files.some(file => file.zipPath.startsWith('spatial/')) && existsSync(DIRS.spatial())
    ? listFilesRecursive(DIRS.spatial()).filter(path => path.endsWith('.json') && !writes.some(write => write.dest === path)) : []
  try {
    // 整份空间数据以备份为准，不能让旧事务或旧助手请求混入恢复后的数据。
    for (const dest of obsoleteSpatial) {
      const snapPath = join(snapshotDir, String(overwritten.size))
      copyFileSync(dest, snapPath); overwritten.set(dest, snapPath)
    }
    for (const { dest } of writes) {
      if (overwritten.has(dest) || created.includes(dest)) continue
      if (existsSync(dest)) {
        const snapPath = join(snapshotDir, String(overwritten.size))
        try {
          copyFileSync(dest, snapPath)
          overwritten.set(dest, snapPath)
        } catch (e) {
          log.warn('恢复快照失败，中止本次恢复', { dest, error: (e as Error).message })
          throw new Error(`备份恢复中止：无法备份现有文件 ${dest}`)
        }
      } else {
        created.push(dest)
      }
    }

    // 校验通过后开始写入
    prepareFeatureDataRestore()
    // sync-bypass-ok: 整库恢复后由调用方执行 fenceSyncStateAfterRestore 作废 journal 并重建基线（总方案 §6.4）
    for (const { zipPath: name, data, dest } of writes) {
      // 对 settings.json 的 apiKey 迁移进 safeStorage（与旧 importBackup 一致）
      if (name === 'config/settings.json') {
        try {
          const parsed = JSON.parse(data.toString('utf-8')) as Settings
          // 若包含旧明文 apiKey，迁移进加密存储
          stripSecretsLocal(parsed, true)
          // sync-bypass-ok: 整库恢复由调用方执行 fenceSyncStateAfterRestore 作废 journal 并重建基线（总方案 §6.4）
          writeJson(dest, parsed)
          continue
        } catch { /* 回退到直接写入 */ }
      }

      mkdirSync(dirname(dest), { recursive: true })
      // 原子写入：temp + rename
      // sync-bypass-ok: 整库恢复由调用方执行 fenceSyncStateAfterRestore 作废 journal 并重建基线（总方案 §6.4）
      const tmp = dest + '.tmp'
      // sync-bypass-ok: 恢复写入的临时文件（下一步 rename 到目标），非业务数据落盘
      writeFileSync(tmp, data)
      try {
        // sync-bypass-ok: 同上，恢复写入的原子替换步骤
        renameSync(tmp, dest)
      } catch {
        try { unlinkSync(tmp) } catch { /* ignore */ }
        // sync-bypass-ok: 同上，rename 失败时的覆盖回退
        writeFileSync(dest, data)
      }
    }

    for (const path of obsoleteSpatial) unlinkSync(path)
    log.info('Backup V2 已导入', { zipPath, counts: manifest.counts })
    return { counts: manifest.counts }
  } catch (e) {
    // 完整回滚：恢复被覆盖文件、删除本次新建文件，避免半导入混合状态
    for (const [dest, snapPath] of overwritten) {
      try { copyFileSync(snapPath, dest) } catch { /* ignore */ }
    }
    for (const dest of created) {
      try { if (existsSync(dest)) unlinkSync(dest) } catch { /* ignore */ }
    }
    throw e
  } finally {
    try { rmSync(snapshotDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

/** 兼容：V1 JSON 备份导入（旧逻辑，供 .json 文件使用） */
export function isV1JsonBackup(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.json')
}
