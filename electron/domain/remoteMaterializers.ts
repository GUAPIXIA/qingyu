/**
 * 阶段 2 S2-06：远端批次 → 业务文件修改计划（materializer）。
 *
 * 与 `bootstrapScanners.ts` 互为反向：扫描器把文件读成规范 payload，
 * 这里把远端 payload 写回 PC 既有的文件布局（角色/预设/世界书一实体一文件；
 * persona/regex/usage/groups 等为单文件数组；会话与消息按父实体定位）。
 *
 * 只生产「计划」；实际的原子替换与 journal 提交由 fileTransaction 完成，
 * 因此任何失败都能整体回滚。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { SyncEntityType, SyncEnvelope } from '../../shared/contracts/sync-envelope'
import type { DomainWriteFile } from './types'

export interface MaterializeContext {
  userDataDir: string
  /** 同一实体类型的远端信封（已通过预检） */
  envelopes: SyncEnvelope[]
}

export interface MaterializeResult {
  files: DomainWriteFile[]
  /** 无法落盘的信封（保留为显式报告，不静默丢弃） */
  unsupported: Array<{ entityId: string; reason: string }>
}

export type Materializer = (ctx: MaterializeContext) => MaterializeResult

function dataRoot(userDataDir: string): string {
  return join(userDataDir, 'data')
}

function readJsonArray(filePath: string): Record<string, unknown>[] {
  if (!existsSync(filePath)) return []
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown
    return Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : []
  } catch {
    return []
  }
}

function readJsonObject(filePath: string): Record<string, unknown> | null {
  if (!existsSync(filePath)) return null
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** 一实体一文件：upsert 写文件，tombstone 删文件 */
function entityPerFile(
  dir: string,
  ctx: MaterializeContext,
  toRecord: (env: SyncEnvelope) => Record<string, unknown>,
): MaterializeResult {
  const files: DomainWriteFile[] = []
  for (const env of ctx.envelopes) {
    const filePath = join(dir, `${env.entityId}.json`)
    if (env.deleted) {
      files.push({ path: filePath, content: null })
      continue
    }
    const record = { id: env.entityId, ...toRecord(env) }
    files.push({ path: filePath, content: JSON.stringify(record, null, 2) })
  }
  return { files, unsupported: [] }
}

/** 单文件数组（persona / regex / usage / groups index / 映射模板）：按 id upsert 或移除 */
function arrayFile(
  filePath: string,
  ctx: MaterializeContext,
  toRecord: (env: SyncEnvelope) => Record<string, unknown>,
  idOf: (record: Record<string, unknown>) => string | undefined = (r) => (typeof r.id === 'string' ? r.id : undefined),
): MaterializeResult {
  const list = readJsonArray(filePath)
  const byId = new Map<string, Record<string, unknown>>()
  const order: string[] = []
  for (const item of list) {
    const id = idOf(item)
    if (!id) continue
    byId.set(id, item)
    order.push(id)
  }
  for (const env of ctx.envelopes) {
    if (env.deleted) {
      if (byId.delete(env.entityId)) {
        const idx = order.indexOf(env.entityId)
        if (idx >= 0) order.splice(idx, 1)
      }
      continue
    }
    const record = { id: env.entityId, ...toRecord(env) }
    if (!byId.has(env.entityId)) order.push(env.entityId)
    byId.set(env.entityId, record)
  }
  const next = order.map((id) => byId.get(id)).filter((x): x is Record<string, unknown> => Boolean(x))
  return { files: [{ path: filePath, content: JSON.stringify(next, null, 2) }], unsupported: [] }
}

/** 会话归属：groupId 目录存在视为群会话，否则视为角色的单聊会话 */
export type SessionOwner = { kind: 'character' | 'group'; id: string }

export function resolveSessionOwner(userDataDir: string, parentId: string | null): SessionOwner | null {
  if (!parentId) return null
  const groupDir = join(dataRoot(userDataDir), 'groups', parentId)
  try {
    if (existsSync(groupDir) && statSync(groupDir).isDirectory()) return { kind: 'group', id: parentId }
  } catch {
    /* ignore */
  }
  return { kind: 'character', id: parentId }
}

/** 按 sessionId 反查其所属容器（消息信封缺少 characterId 时使用） */
export function findSessionOwnerBySessionId(userDataDir: string, sessionId: string): SessionOwner | null {
  const data = dataRoot(userDataDir)
  const groupsDir = join(data, 'groups')
  if (existsSync(groupsDir)) {
    if (existsSync(join(groupsDir, sessionId))) return { kind: 'group', id: sessionId }
    for (const groupId of safeReaddir(groupsDir)) {
      if (existsSync(join(groupsDir, groupId, `${sessionId}.jsonl`))) {
        return { kind: 'group', id: groupId }
      }
    }
  }
  const chatsDir = join(data, 'chats')
  if (existsSync(chatsDir)) {
    for (const characterId of safeReaddir(chatsDir)) {
      if (existsSync(join(chatsDir, characterId, `${sessionId}.jsonl`))) {
        return { kind: 'character', id: characterId }
      }
    }
  }
  return null
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => !n.startsWith('.'))
  } catch {
    return []
  }
}

function sessionFileFor(userDataDir: string, owner: SessionOwner, sessionId: string): string {
  const base = owner.kind === 'group' ? join(dataRoot(userDataDir), 'groups', owner.id) : join(dataRoot(userDataDir), 'chats', owner.id)
  return join(base, `${sessionId}.jsonl`)
}

function sessionsIndexFor(userDataDir: string, owner: SessionOwner): string {
  const base = owner.kind === 'group' ? join(dataRoot(userDataDir), 'groups', owner.id) : join(dataRoot(userDataDir), 'chats', owner.id)
  return join(base, 'sessions.json')
}

/**
 * JSONL 消息：整文件重写为「去重后的目标集合」。
 * 远端信封可能新增或更新消息，tombstone 则从文件中移除该 id。
 */
function messageMaterializer(ctx: MaterializeContext): MaterializeResult {
  // 按 (owner, sessionId) 分组
  const groups = new Map<string, { owner: SessionOwner; sessionId: string; envs: SyncEnvelope[] }>()
  const unsupported: MaterializeResult['unsupported'] = []

  for (const env of ctx.envelopes) {
    const sessionId =
      (typeof env.payload === 'object' && env.payload && typeof (env.payload as Record<string, unknown>).sessionId === 'string'
        ? String((env.payload as Record<string, unknown>).sessionId)
        : null) ?? env.parentId
    if (!sessionId) {
      unsupported.push({ entityId: env.entityId, reason: '消息缺少 sessionId' })
      continue
    }
    const characterId =
      typeof env.payload === 'object' && env.payload && typeof (env.payload as Record<string, unknown>).characterId === 'string'
        ? String((env.payload as Record<string, unknown>).characterId)
        : null

    let owner: SessionOwner | null = null
    if (env.aggregateId) {
      const kind = env.aggregateType === 'group' ? 'group' : 'character'
      owner = { kind, id: env.aggregateId }
    } else if (characterId) {
      owner = { kind: 'character', id: characterId }
    } else {
      owner = findSessionOwnerBySessionId(ctx.userDataDir, sessionId)
    }
    if (!owner) {
      unsupported.push({ entityId: env.entityId, reason: `无法定位会话 ${sessionId} 的归属容器` })
      continue
    }
    const key = `${owner.kind}:${owner.id}/${sessionId}`
    const bucket = groups.get(key) ?? { owner, sessionId, envs: [] }
    bucket.envs.push(env)
    groups.set(key, bucket)
  }

  const files: DomainWriteFile[] = []
  for (const { owner, sessionId, envs } of groups.values()) {
    const filePath = sessionFileFor(ctx.userDataDir, owner, sessionId)
    const existing = new Map<string, string>()
    if (existsSync(filePath)) {
      for (const line of readFileSync(filePath, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          const parsed = JSON.parse(line) as { id?: unknown }
          if (parsed && typeof parsed.id === 'string') existing.set(parsed.id, line)
        } catch {
          /* 损坏行保持原样 */
        }
      }
    }
    for (const env of envs) {
      if (env.deleted) {
        existing.delete(env.entityId)
        continue
      }
      existing.set(env.entityId, JSON.stringify({ id: env.entityId, ...(env.payload as Record<string, unknown>) }))
    }
    const content = existing.size ? [...existing.values()].join('\n') + '\n' : ''
    files.push({ path: filePath, content })
  }
  return { files, unsupported }
}

function sessionMaterializer(ctx: MaterializeContext): MaterializeResult {
  // 按 owner 分组（多会话可能落在同一个 sessions.json）
  const groups = new Map<string, { owner: SessionOwner; envs: SyncEnvelope[] }>()
  const unsupported: MaterializeResult['unsupported'] = []
  for (const env of ctx.envelopes) {
    const parentId = env.parentId
    const owner = resolveSessionOwner(ctx.userDataDir, parentId)
    if (!owner) {
      unsupported.push({ entityId: env.entityId, reason: '会话缺少 parentId，无法定位容器' })
      continue
    }
    const key = `${owner.kind}:${owner.id}`
    const bucket = groups.get(key) ?? { owner, envs: [] }
    bucket.envs.push(env)
    groups.set(key, bucket)
  }
  const files: DomainWriteFile[] = []
  for (const { owner, envs } of groups.values()) {
    const filePath = sessionsIndexFor(ctx.userDataDir, owner)
    const result = arrayFile(filePath, { userDataDir: ctx.userDataDir, envelopes: envs }, (env) => ({
      ...(env.payload as Record<string, unknown>),
      characterId: (env.payload as Record<string, unknown>).characterId ?? owner.id,
    }))
    files.push(...result.files)
  }
  return { files, unsupported }
}

function quickReplyMaterializer(ctx: MaterializeContext): MaterializeResult {
  const filePath = join(dataRoot(ctx.userDataDir), 'config', 'quickReplies.json')
  const files: DomainWriteFile[] = []
  for (const env of ctx.envelopes) {
    if (env.deleted) {
      files.push({ path: filePath, content: null })
      continue
    }
    files.push({ path: filePath, content: JSON.stringify(env.payload, null, 2) })
  }
  return { files, unsupported: [] }
}

function settingsPublicMaterializer(ctx: MaterializeContext): MaterializeResult {
  const filePath = join(dataRoot(ctx.userDataDir), 'config', 'settings.json')
  const current = readJsonObject(filePath) ?? {}
  const next = { ...current }
  let touched = false
  for (const env of ctx.envelopes) {
    if (env.deleted) continue
    const payload = env.payload as Record<string, unknown>
    // 只合并 settings_public 允许的字段，绝不覆盖凭据等本地字段
    const MAPPING: Record<string, string> = {
      theme: 'theme',
      language: 'language',
      narrativeMode: 'defaultNarrativeMode',
      responseLengthMode: 'responseLengthMode',
      activePresetId: 'activePresetId',
      activePersonaId: 'activePersonaId',
    }
    for (const [publicKey, settingsKey] of Object.entries(MAPPING)) {
      if (payload[publicKey] !== undefined) {
        next[settingsKey] = payload[publicKey]
        touched = true
      }
    }
  }
  if (!touched) return { files: [], unsupported: [] }
  return { files: [{ path: filePath, content: JSON.stringify(next, null, 2) }], unsupported: [] }
}

function mcpPublicMaterializer(ctx: MaterializeContext): MaterializeResult {
  const filePath = join(dataRoot(ctx.userDataDir), 'config', 'mcp-servers.json')
  const list = readJsonArray(filePath)
  const byId = new Map<string, Record<string, unknown>>()
  for (const item of list) {
    if (typeof item.id === 'string') byId.set(item.id, item)
  }
  for (const env of ctx.envelopes) {
    if (env.deleted) {
      byId.delete(env.entityId)
      continue
    }
    // 只写公共字段：保留本地既有 env/headers/command，避免远端覆盖本地敏感配置
    const prev = byId.get(env.entityId) ?? { id: env.entityId }
    const payload = env.payload as Record<string, unknown>
    byId.set(env.entityId, {
      ...prev,
      id: env.entityId,
      name: payload.name ?? prev.name ?? '',
      transport: payload.transport ?? prev.transport ?? 'stdio',
      enabled: typeof payload.enabled === 'boolean' ? payload.enabled : (prev.enabled ?? true),
    })
  }
  return { files: [{ path: filePath, content: JSON.stringify([...byId.values()], null, 2) }], unsupported: [] }
}

/** PC 存储没有独立落点的实体类型：显式报告，不静默丢弃 */
function unsupportedMaterializer(reason: string): Materializer {
  return (ctx) => ({
    files: [],
    unsupported: ctx.envelopes.map((env) => ({ entityId: env.entityId, reason })),
  })
}

export const MATERIALIZERS: Record<SyncEntityType, Materializer> = {
  character: (ctx) => entityPerFile(join(dataRoot(ctx.userDataDir), 'characters'), ctx, (env) => env.payload as Record<string, unknown>),
  preset: (ctx) => entityPerFile(join(dataRoot(ctx.userDataDir), 'presets'), ctx, (env) => env.payload as Record<string, unknown>),
  lorebook: (ctx) => entityPerFile(join(dataRoot(ctx.userDataDir), 'lorebooks'), ctx, (env) => env.payload as Record<string, unknown>),
  persona: (ctx) => arrayFile(join(dataRoot(ctx.userDataDir), 'config', 'personas.json'), ctx, (env) => env.payload as Record<string, unknown>),
  regex_rule: (ctx) => arrayFile(join(dataRoot(ctx.userDataDir), 'config', 'regex', 'rules.json'), ctx, (env) => env.payload as Record<string, unknown>),
  usage_record: (ctx) => arrayFile(join(dataRoot(ctx.userDataDir), 'config', 'usage.json'), ctx, (env) => env.payload as Record<string, unknown>),
  group: (ctx) => arrayFile(join(dataRoot(ctx.userDataDir), 'groups', 'index.json'), ctx, (env) => env.payload as Record<string, unknown>),
  lorebook_mapping_template: (ctx) =>
    arrayFile(join(dataRoot(ctx.userDataDir), 'config', 'lorebook-mapping-templates.json'), ctx, (env) => env.payload as Record<string, unknown>),
  session: sessionMaterializer,
  message: messageMaterializer,
  settings_public: settingsPublicMaterializer,
  quick_reply_set: quickReplyMaterializer,
  mcp_public_config: mcpPublicMaterializer,
  media_manifest: unsupportedMaterializer('PC 尚无 media_manifest 独立落点（阶段 7 引入 blob 存储后实现）'),
  memory_state: unsupportedMaterializer('PC 的长记忆内嵌在 session 实体中，无独立落点'),
  memory_fact: unsupportedMaterializer('PC 的事实记录内嵌在 session 实体中，无独立落点'),
  usage_clear_marker: () => ({
    // usage_clear_marker 不需要改文件：它由 head/journal 记录，实际清理语义由阶段 7 sync core 应用
    files: [],
    unsupported: [],
  }),
}
