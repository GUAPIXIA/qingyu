/**
 * 阶段 2 S2-05：旧数据只读扫描器。
 *
 * 只读现有 JSON/JSONL 文件，产出与阶段 1 冻结 schema 一致的规范 payload。
 * 任何解析失败都降级为 BootstrapIssue，不修改原数据。
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { BootstrapIssue, BootstrapScanItem } from './types'
import type { DomainFlagKey } from './featureFlag'
import { toMobileSafeSettings } from '../bridge/settingsSync'
import type { Settings } from '../../shared/types'

export interface ScanOutput {
  items: BootstrapScanItem[]
  issues: BootstrapIssue[]
}

/** 每个域扫描需要的目录根（全部相对 userDataDir） */
export interface ScanRoots {
  configDir: string
  charactersDir: string
  lorebooksDir: string
  presetsDir: string
  groupsDir: string
  chatsDir: string
}

export function defaultScanRoots(userDataDir: string): ScanRoots {
  const data = join(userDataDir, 'data')
  return {
    configDir: join(data, 'config'),
    charactersDir: join(data, 'characters'),
    lorebooksDir: join(data, 'lorebooks'),
    presetsDir: join(data, 'presets'),
    groupsDir: join(data, 'groups'),
    chatsDir: join(data, 'chats'),
  }
}

export interface ScanContext {
  roots: ScanRoots
  maxPayloadBytes: number
}

export const DEFAULT_MAX_PAYLOAD_BYTES = 2 * 1024 * 1024

function issue(
  issues: BootstrapIssue[],
  kind: BootstrapIssue['kind'],
  entityType: string,
  entityId: string,
  detail: string,
): void {
  issues.push({ kind, entityType, entityId, detail })
}

function readJsonSafe(filePath: string, issues: BootstrapIssue[], entityType: string): unknown | null {
  if (!existsSync(filePath)) return null
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as unknown
  } catch (err) {
    issue(issues, 'unreadable_file', entityType, filePath.split(/[\\/]/).pop() ?? filePath, String(err))
    return null
  }
}

function listJsonFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('.'))
  } catch {
    return []
  }
}

/** 有界内存的 JSONL 逐行读取（百万级 message 不整文件载入） */
export function forEachJsonlLine(filePath: string, onLine: (line: string) => void): void {
  if (!existsSync(filePath)) return
  const fd = openSync(filePath, 'r')
  try {
    const buf = Buffer.allocUnsafe(64 * 1024)
    let carry = ''
    let bytes = 0
    for (;;) {
      bytes = readSync(fd, buf, 0, buf.length, null)
      if (bytes <= 0) break
      carry += buf.toString('utf8', 0, bytes)
      let idx = carry.indexOf('\n')
      while (idx >= 0) {
        const line = carry.slice(0, idx)
        if (line.trim()) onLine(line)
        carry = carry.slice(idx + 1)
        idx = carry.indexOf('\n')
      }
    }
    if (carry.trim()) onLine(carry)
  } finally {
    closeSync(fd)
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

function strArray(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string').slice(0, max)
}

function payloadSizeOk(payload: Record<string, unknown>, ctx: ScanContext): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(payload), 'utf8') <= ctx.maxPayloadBytes
  } catch {
    return false
  }
}

// ===================== 各域扫描器 =====================

export function scanSettingsPublic(ctx: ScanContext): ScanOutput {
  const items: BootstrapScanItem[] = []
  const issues: BootstrapIssue[] = []
  const raw = readJsonSafe(join(ctx.roots.configDir, 'settings.json'), issues, 'settings_public')
  if (!isRecord(raw)) return { items, issues }
  const safe = toMobileSafeSettings(raw as unknown as Settings)
  const payload: Record<string, unknown> = {
    activePresetId: safe.activePresetId ?? null,
    ...(typeof raw.language === 'string' ? { language: raw.language } : {}),
  }
  items.push({ entityType: 'settings_public', entityId: 'settings-public', payload, schemaVersion: 1 })
  return { items, issues }
}

export function scanPersonas(ctx: ScanContext): ScanOutput {
  const items: BootstrapScanItem[] = []
  const issues: BootstrapIssue[] = []
  const raw = readJsonSafe(join(ctx.roots.configDir, 'personas.json'), issues, 'persona')
  if (!Array.isArray(raw)) return { items, issues }
  for (const entry of raw) {
    if (!isRecord(entry)) continue
    const id = str(entry.id)
    if (!id) continue
    const payload = {
      name: str(entry.name),
      description: str(entry.description),
      persona: str(entry.persona),
    }
    if (!payloadSizeOk(payload, ctx)) {
      issue(issues, 'invalid_payload', 'persona', id, 'payload 超过 2MiB')
      continue
    }
    items.push({ entityType: 'persona', entityId: id, payload, schemaVersion: 1 })
  }
  return { items, issues }
}

export function scanRegexRules(ctx: ScanContext): ScanOutput {
  const items: BootstrapScanItem[] = []
  const issues: BootstrapIssue[] = []
  const raw = readJsonSafe(join(ctx.roots.configDir, 'regex', 'rules.json'), issues, 'regex_rule')
  if (!Array.isArray(raw)) return { items, issues }
  for (const entry of raw) {
    if (!isRecord(entry)) continue
    const id = str(entry.id)
    if (!id) continue
    const payload: Record<string, unknown> = { ...entry }
    delete payload.id
    if (!payloadSizeOk(payload, ctx)) {
      issue(issues, 'invalid_payload', 'regex_rule', id, 'payload 超过 2MiB')
      continue
    }
    items.push({ entityType: 'regex_rule', entityId: id, payload, schemaVersion: 1 })
  }
  return { items, issues }
}

export function scanQuickReplies(ctx: ScanContext): ScanOutput {
  const items: BootstrapScanItem[] = []
  const issues: BootstrapIssue[] = []
  const raw = readJsonSafe(join(ctx.roots.configDir, 'quickReplies.json'), issues, 'quick_reply_set')
  if (!isRecord(raw)) return { items, issues }
  const payload: Record<string, unknown> = {
    global: Array.isArray(raw.global) ? raw.global : [],
    byCharacter: isRecord(raw.byCharacter) ? raw.byCharacter : {},
  }
  if (!payloadSizeOk(payload, ctx)) {
    issue(issues, 'invalid_payload', 'quick_reply_set', 'quick-replies-root', 'payload 超过 2MiB')
    return { items, issues }
  }
  items.push({ entityType: 'quick_reply_set', entityId: 'quick-replies-root', payload, schemaVersion: 1 })
  return { items, issues }
}

export function scanPresets(ctx: ScanContext): ScanOutput {
  const items: BootstrapScanItem[] = []
  const issues: BootstrapIssue[] = []
  for (const file of listJsonFiles(ctx.roots.presetsDir)) {
    const raw = readJsonSafe(join(ctx.roots.presetsDir, file), issues, 'preset')
    if (!isRecord(raw)) continue
    const id = str(raw.id) || file.replace(/\.json$/, '')
    const payload: Record<string, unknown> = { ...raw }
    delete payload.id
    if (!payloadSizeOk(payload, ctx)) {
      issue(issues, 'invalid_payload', 'preset', id, 'payload 超过 2MiB')
      continue
    }
    items.push({ entityType: 'preset', entityId: id, payload, schemaVersion: 1 })
  }
  return { items, issues }
}

export function scanLorebooks(ctx: ScanContext): ScanOutput {
  const items: BootstrapScanItem[] = []
  const issues: BootstrapIssue[] = []
  for (const file of listJsonFiles(ctx.roots.lorebooksDir)) {
    const raw = readJsonSafe(join(ctx.roots.lorebooksDir, file), issues, 'lorebook')
    if (!isRecord(raw)) continue
    const id = str(raw.id) || file.replace(/\.json$/, '')
    const payload: Record<string, unknown> = { ...raw }
    delete payload.id
    if (!payloadSizeOk(payload, ctx)) {
      issue(issues, 'invalid_payload', 'lorebook', id, 'payload 超过 2MiB')
      continue
    }
    items.push({ entityType: 'lorebook', entityId: id, payload, schemaVersion: 1 })
  }

  const templates = readJsonSafe(
    join(ctx.roots.configDir, 'lorebook-mapping-templates.json'),
    issues,
    'lorebook_mapping_template',
  )
  if (Array.isArray(templates)) {
    for (const entry of templates) {
      if (!isRecord(entry)) continue
      const id = str(entry.id)
      if (!id) continue
      const payload: Record<string, unknown> = { ...entry }
      delete payload.id
      items.push({ entityType: 'lorebook_mapping_template', entityId: id, payload, schemaVersion: 1 })
    }
  }
  return { items, issues }
}

export function scanCharacters(ctx: ScanContext): ScanOutput {
  const items: BootstrapScanItem[] = []
  const issues: BootstrapIssue[] = []
  for (const file of listJsonFiles(ctx.roots.charactersDir)) {
    const raw = readJsonSafe(join(ctx.roots.charactersDir, file), issues, 'character')
    if (!isRecord(raw)) continue
    const id = str(raw.id) || file.replace(/\.json$/, '')
    const name = str(raw.name)
    if (!name) {
      issue(issues, 'invalid_payload', 'character', id, '缺少 name')
      continue
    }
    const payload: Record<string, unknown> = { name }
    if (typeof raw.description === 'string') payload.description = raw.description
    if (typeof raw.personality === 'string') payload.personality = raw.personality
    if (typeof raw.scenario === 'string') payload.scenario = raw.scenario
    if (typeof raw.firstMessage === 'string') payload.firstMessage = raw.firstMessage
    if (typeof raw.exampleDialog === 'string') payload.exampleDialog = raw.exampleDialog
    if (typeof raw.systemPrompt === 'string') payload.systemPrompt = raw.systemPrompt
    if (typeof raw.creator === 'string') payload.creator = raw.creator
    if (Array.isArray(raw.tags)) payload.tags = strArray(raw.tags, 64)
    if (Array.isArray(raw.alternateGreetings)) payload.alternateGreetings = strArray(raw.alternateGreetings, 32)
    if (Array.isArray(raw.boundLorebookIds)) payload.boundLorebookIds = strArray(raw.boundLorebookIds, 32)
    if (raw.boundPresetId !== undefined) {
      payload.boundPresetId = typeof raw.boundPresetId === 'string' ? raw.boundPresetId : null
    }
    if (isRecord(raw.extensions)) payload.extensions = raw.extensions
    if (!payloadSizeOk(payload, ctx)) {
      issue(issues, 'invalid_payload', 'character', id, 'payload 超过 2MiB')
      continue
    }
    items.push({ entityType: 'character', entityId: id, payload, schemaVersion: 1 })
  }
  return { items, issues }
}

function scanSessionList(
  filePath: string,
  parentId: string | null,
  ctx: ScanContext,
  issues: BootstrapIssue[],
): BootstrapScanItem[] {
  const raw = readJsonSafe(filePath, issues, 'session')
  if (!Array.isArray(raw)) return []
  const items: BootstrapScanItem[] = []
  for (const entry of raw) {
    if (!isRecord(entry)) continue
    const id = str(entry.id)
    if (!id) continue
    const payload: Record<string, unknown> = { ...entry }
    delete payload.id
    if (!payloadSizeOk(payload, ctx)) {
      issue(issues, 'invalid_payload', 'session', id, 'payload 超过 2MiB')
      continue
    }
    items.push({
      entityType: 'session',
      entityId: id,
      parentId,
      payload,
      schemaVersion: 1,
      ...(parentId ? { references: [parentId] } : {}),
    })
  }
  return items
}

function scanMessageFile(
  filePath: string,
  sessionId: string,
  parentId: string | null,
  issues: BootstrapIssue[],
): BootstrapScanItem[] {
  const items: BootstrapScanItem[] = []
  forEachJsonlLine(filePath, (line) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      issue(issues, 'invalid_payload', 'message', sessionId, 'JSONL 行解析失败')
      return
    }
    if (!isRecord(parsed)) return
    const id = str(parsed.id)
    if (!id) return
    const payload: Record<string, unknown> = {
      sessionId: str(parsed.sessionId, sessionId),
      role: str(parsed.role, 'assistant'),
      content: str(parsed.content),
      timestamp: typeof parsed.timestamp === 'number' ? parsed.timestamp : 0,
    }
    if (typeof parsed.characterId === 'string' || parsed.characterId === null) {
      payload.characterId = parsed.characterId
    }
    for (const key of ['speakerKind', 'generationKind', 'narrativeMode'] as const) {
      if (typeof parsed[key] === 'string') payload[key] = parsed[key]
    }
    if (Array.isArray(parsed.swipes)) payload.swipes = strArray(parsed.swipes, 32)
    if (typeof parsed.swipeIndex === 'number') payload.swipeIndex = parsed.swipeIndex
    if (typeof parsed.replyToId === 'string' || parsed.replyToId === null) payload.replyToId = parsed.replyToId
    if (typeof parsed.isDeleted === 'boolean') payload.isDeleted = parsed.isDeleted
    items.push({
      entityType: 'message',
      entityId: id,
      parentId: parentId ?? str(parsed.sessionId, sessionId),
      payload,
      schemaVersion: 1,
      references: [str(parsed.sessionId, sessionId)],
    })
  })
  return items
}

export function scanChats(ctx: ScanContext): ScanOutput {
  const items: BootstrapScanItem[] = []
  const issues: BootstrapIssue[] = []
  if (!existsSync(ctx.roots.chatsDir)) return { items, issues }
  let charDirs: string[] = []
  try {
    charDirs = readdirSync(ctx.roots.chatsDir).filter((d) => {
      if (d.startsWith('.')) return false
      try {
        return statSync(join(ctx.roots.chatsDir, d)).isDirectory()
      } catch {
        return false
      }
    })
  } catch {
    return { items, issues }
  }

  for (const characterId of charDirs) {
    const dir = join(ctx.roots.chatsDir, characterId)
    const sessions = scanSessionList(join(dir, 'sessions.json'), characterId, ctx, issues)
    items.push(...sessions)
    for (const file of listJsonlFiles(dir)) {
      const sessionId = file.replace(/\.jsonl$/, '')
      items.push(...scanMessageFile(join(dir, file), sessionId, sessionId, issues))
    }
  }
  return { items, issues }
}

function listJsonlFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.jsonl') && !f.startsWith('.'))
  } catch {
    return []
  }
}

export function scanGroups(ctx: ScanContext): ScanOutput {
  const items: BootstrapScanItem[] = []
  const issues: BootstrapIssue[] = []
  const index = readJsonSafe(join(ctx.roots.groupsDir, 'index.json'), issues, 'group')
  if (Array.isArray(index)) {
    for (const entry of index) {
      if (!isRecord(entry)) continue
      const id = str(entry.id)
      if (!id) continue
      const payload: Record<string, unknown> = { ...entry }
      delete payload.id
      if (!payloadSizeOk(payload, ctx)) {
        issue(issues, 'invalid_payload', 'group', id, 'payload 超过 2MiB')
        continue
      }
      items.push({ entityType: 'group', entityId: id, payload, schemaVersion: 1 })
    }
  }

  if (!existsSync(ctx.roots.groupsDir)) return { items, issues }
  let groupDirs: string[] = []
  try {
    groupDirs = readdirSync(ctx.roots.groupsDir).filter((d) => {
      if (d.startsWith('.')) return false
      try {
        return statSync(join(ctx.roots.groupsDir, d)).isDirectory()
      } catch {
        return false
      }
    })
  } catch {
    return { items, issues }
  }

  for (const groupId of groupDirs) {
    const dir = join(ctx.roots.groupsDir, groupId)
    items.push(...scanSessionList(join(dir, 'sessions.json'), groupId, ctx, issues))
    for (const file of listJsonlFiles(dir)) {
      const sessionId = file.replace(/\.jsonl$/, '')
      items.push(...scanMessageFile(join(dir, file), sessionId, sessionId, issues))
    }
  }
  return { items, issues }
}

export function scanUsage(ctx: ScanContext): ScanOutput {
  const items: BootstrapScanItem[] = []
  const issues: BootstrapIssue[] = []
  const raw = readJsonSafe(join(ctx.roots.configDir, 'usage.json'), issues, 'usage_record')
  if (!Array.isArray(raw)) return { items, issues }
  for (const entry of raw) {
    if (!isRecord(entry)) continue
    const id = str(entry.id)
    if (!id) continue
    const payload: Record<string, unknown> = { ...entry }
    delete payload.id
    if (!payloadSizeOk(payload, ctx)) continue
    items.push({ entityType: 'usage_record', entityId: id, payload, schemaVersion: 1 })
  }
  return { items, issues }
}

export function scanMcpPublic(ctx: ScanContext): ScanOutput {
  const items: BootstrapScanItem[] = []
  const issues: BootstrapIssue[] = []
  const raw = readJsonSafe(join(ctx.roots.configDir, 'mcp-servers.json'), issues, 'mcp_public_config')
  if (!Array.isArray(raw)) return { items, issues }
  for (const entry of raw) {
    if (!isRecord(entry)) continue
    const id = str(entry.id)
    if (!id) continue
    // 仅公共字段：env / headers / command 一律不同步（总方案 §6.1、§3.3）
    const payload: Record<string, unknown> = {
      name: str(entry.name),
      transport: str(entry.transport, 'stdio'),
      enabled: entry.enabled === true,
    }
    items.push({ entityType: 'mcp_public_config', entityId: id, payload, schemaVersion: 1 })
  }
  return { items, issues }
}

export const DOMAIN_ENTITY_TYPES: Record<DomainFlagKey, string[]> = {
  settings_public: ['settings_public'],
  persona: ['persona'],
  regex_rule: ['regex_rule'],
  quick_reply_set: ['quick_reply_set'],
  preset: ['preset'],
  lorebook: ['lorebook', 'lorebook_mapping_template'],
  character: ['character'],
  session: ['session'],
  message: ['message'],
  group: ['group', 'session', 'message'],
  usage_record: ['usage_record'],
  mcp_public_config: ['mcp_public_config'],
}

export const DOMAIN_SCANNERS: Partial<Record<DomainFlagKey, (ctx: ScanContext) => ScanOutput>> = {
  settings_public: scanSettingsPublic,
  persona: scanPersonas,
  regex_rule: scanRegexRules,
  quick_reply_set: scanQuickReplies,
  preset: scanPresets,
  lorebook: scanLorebooks,
  character: scanCharacters,
  session: scanChats,
  message: scanChats,
  group: scanGroups,
  usage_record: scanUsage,
  mcp_public_config: scanMcpPublic,
}
