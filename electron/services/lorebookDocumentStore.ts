import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { appendFile, readdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { Lorebook } from '../../shared/types'
import type { CanonicalLorebookDocumentV2 } from '../../shared/lorebook/domain/v2'
import { validateCanonicalLorebookV2 } from '../../shared/lorebook/domain/validation'
import { migrateLorebookDocumentToLatest } from '../../shared/lorebook/migrations'
import { compileCanonicalLorebookV2 } from '../../shared/lorebook/runtime/compile'
import { writeThroughDomain } from '../domain/syncDomainService'
import { readJson, readJsonAsync, serializeJson } from './storage'

/** 乐观冲突（方案 §10.3）：磁盘 revision 与保存方基于的 revision 不一致时抛出。 */
export class LorebookSaveConflictError extends Error {
  constructor(
    public readonly onDiskRevision: number,
    public readonly expectedRevision: number,
  ) {
    super(
      `LOREBOOK_SAVE_CONFLICT：世界书在磁盘上已被其他窗口更新（磁盘 revision ${onDiskRevision}，本地基于 revision ${expectedRevision}）。已放弃本次保存，请刷新后重试。`,
    )
    this.name = 'LorebookSaveConflictError'
  }
}

function contentHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function migrate(value: unknown, now = Date.now(), revision = 1): CanonicalLorebookDocumentV2 {
  return migrateLorebookDocumentToLatest(value, {
    now,
    revision,
    contentHash: contentHash(value),
  })
}

function readStoredCanonical(filePath: string): CanonicalLorebookDocumentV2 | null {
  const raw = readJson<unknown>(filePath)
  if (!raw) return null
  const validation = validateCanonicalLorebookV2(raw)
  return validation.valid ? validation.value : null
}

function legacyMigrationBackupDir(filePath: string): string {
  return join(dirname(filePath), '..', 'backups', 'lorebook-migrations')
}

function migrationLogPath(filePath: string): string {
  return join(dirname(filePath), '..', 'logs', 'lorebook-migration.jsonl')
}

/**
 * 方案 §10.1：legacy 文件首次升级为 canonical v2（覆盖写入）前，
 * 先制作可恢复备份，并写入迁移日志。备份失败时中止保存，不允许无备份地覆盖旧格式数据。
 */
function ensureLegacyBackupBeforeV2Write(filePath: string): void {
  if (!existsSync(filePath)) return
  const raw = readJson<unknown>(filePath)
  if (!raw || validateCanonicalLorebookV2(raw).valid) return
  const backupDir = legacyMigrationBackupDir(filePath)
  mkdirSync(backupDir, { recursive: true })
  const backupPath = join(backupDir, `${basename(filePath, '.json')}-${Date.now()}.legacy.json`)
  copyFileSync(filePath, backupPath)
  // 迁移日志是本地审计产物（<data>/logs 下，不属于同步域业务文件，不参与 journal），
  // 异步追加以免阻塞保存路径；日志失败不阻塞迁移本身。
  try {
    mkdirSync(dirname(migrationLogPath(filePath)), { recursive: true })
    void appendFile(migrationLogPath(filePath), `${JSON.stringify({
      at: Date.now(),
      bookId: basename(filePath, '.json'),
      from: 'legacy',
      to: 2,
      backupPath,
      reason: 'first-save-upgrade',
    })}\n`, 'utf-8').catch(() => { /* 日志失败忽略 */ })
  } catch { /* 日志失败忽略 */ }
}

function preserveCanonicalOnlyFields(
  previous: CanonicalLorebookDocumentV2,
  next: CanonicalLorebookDocumentV2,
): CanonicalLorebookDocumentV2 {
  const previousEntries = new Map(previous.entries.map((entry) => [entry.id, entry]))
  return {
    ...next,
    revision: previous.revision + 1,
    createdAt: previous.createdAt,
    source: previous.source ?? next.source,
    foreign: {
      ...(previous.foreign ?? {}),
      ...(next.foreign ?? {}),
    },
    entries: next.entries.map((entry) => {
      const old = previousEntries.get(entry.id)
      if (!old) return entry
      const aliases = old.activation.aliases.filter((alias) => entry.activation.primaryKeys.includes(alias))
      const primaryKeys = entry.activation.primaryKeys.filter((key) => !aliases.includes(key))

      const projectedMode = old.activation.mode === 'constant' ? 'constant' : 'conditional'
      const projectedBudgetTier = old.activation.mode === 'constant'
        ? 'protected'
        : old.activation.budgetTier === 'supplemental'
          ? 'supplemental'
          : 'standard'
      const activationPolicyUnchanged = entry.activation.mode === projectedMode
        && entry.activation.budgetTier === projectedBudgetTier
      const projectedRetrieval = old.activation.retrieval === 'keyword'
        ? 'keyword'
        : old.activation.retrieval === 'hybrid'
          ? 'hybrid'
          : 'semanticPreferred'
      const retrievalUnchanged = entry.activation.retrieval === projectedRetrieval

      const oldInsertionIsCanonicalOnly = old.insertion.kind === 'outlet'
        || old.insertion.kind === 'custom'
        || (old.insertion.kind === 'prompt'
          && !['before_character', 'after_character', 'prompt_end'].includes(old.insertion.anchor))
      const insertionProjectionUnchanged = oldInsertionIsCanonicalOnly
        && entry.insertion.kind === 'prompt'
        && entry.insertion.anchor === 'prompt_end'

      const firstOldGroup = old.scheduling.groups[0]
      const groupProjectionUnchanged = old.scheduling.groups.length === entry.scheduling.groups.length
        && old.scheduling.groups.every((group, index) => {
          const nextGroup = entry.scheduling.groups[index]
          return nextGroup?.name === group.name
            && nextGroup.weight === firstOldGroup?.weight
            && nextGroup.prioritized === firstOldGroup?.prioritized
        })
      return {
        ...entry,
        sourceId: old.sourceId ?? entry.sourceId,
        title: old.title ?? entry.title,
        activation: {
          ...entry.activation,
          ...(activationPolicyUnchanged
            ? { mode: old.activation.mode, budgetTier: old.activation.budgetTier }
            : {}),
          ...(retrievalUnchanged ? { retrieval: old.activation.retrieval } : {}),
          primaryKeys,
          aliases,
          // 当前兼容 Lorebook view 没有 keyLogic，保存时必须保留原值。
          keyLogic: old.activation.keyLogic,
        },
        insertion: insertionProjectionUnchanged ? old.insertion : entry.insertion,
        scheduling: {
          ...entry.scheduling,
          groups: groupProjectionUnchanged ? old.scheduling.groups : entry.scheduling.groups,
        },
        foreign: {
          ...(old.foreign ?? {}),
          ...(entry.foreign ?? {}),
        },
      }
    }),
  }
}

/** runtime 元数据来自 canonical 编译结果，不是用户编辑值；保存时仍以旧 UI 字段判断显式修改。 */
function withoutRuntimeMetadata(lorebook: Lorebook): Lorebook {
  const book = { ...lorebook }
  delete book.runtime
  book.entries = lorebook.entries.map((entry) => {
    const editable = { ...entry }
    delete editable.runtime
    return editable
  })
  return book
}

export function readLorebookDocument(filePath: string): CanonicalLorebookDocumentV2 | null {
  const raw = readJson<unknown>(filePath)
  if (!raw) return null
  try {
    return migrate(raw)
  } catch {
    return null
  }
}

export async function readLorebookDocumentAsync(filePath: string): Promise<CanonicalLorebookDocumentV2 | null> {
  const raw = await readJsonAsync<unknown>(filePath)
  if (!raw) return null
  try {
    return migrate(raw)
  } catch {
    return null
  }
}

export function readLorebookView(filePath: string): Lorebook | null {
  const document = readLorebookDocument(filePath)
  return document ? compileCanonicalLorebookV2(document) : null
}

export async function readLorebookViewAsync(filePath: string): Promise<Lorebook | null> {
  const document = await readLorebookDocumentAsync(filePath)
  return document ? compileCanonicalLorebookV2(document) : null
}

export async function listLorebookViews(dir: string): Promise<Lorebook[]> {
  if (!existsSync(dir)) return []
  try {
    const files = (await readdir(dir)).filter((file) => file.endsWith('.json'))
    const views = await Promise.all(files.map((file) => readLorebookViewAsync(join(dir, file))))
    return views.filter((view): view is Lorebook => view !== null)
  } catch {
    return []
  }
}

/**
 * 阶段 2 S2-04 canonical payload：与 bootstrap 扫描器（bootstrapScanners.scanLorebooks）
 * 保持一致 —— 落盘 canonical v2 文档去掉实体 id，不携带任何敏感值。
 */
export function lorebookEntityPayload(document: CanonicalLorebookDocumentV2): Record<string, unknown> {
  const payload: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(document)) {
    if (key !== 'id') payload[key] = value
  }
  return payload
}

/**
 * 阶段 2 S2-04 收口入口：lorebook 实体的唯一落盘瓶颈。
 * 业务文件字节（与原 writeJson 完全一致）与 journal 在同一持久化事务中提交；
 * domain flag 关闭时入口内部退化为旧行为（同目录 tmp + rename 原子直写，不写 journal）。
 * IPC、导入、备份恢复与角色卡内嵌世界书等所有写入都必须经由本函数
 * （IPC 需要在文件锁内先构建文档时，使用 build* + 本函数的组合）。
 */
export function commitLorebookDocument(filePath: string, document: CanonicalLorebookDocumentV2): void {
  writeThroughDomain({
    domain: 'lorebook',
    entityType: 'lorebook',
    entityId: document.id,
    payload: lorebookEntityPayload(document),
    schemaVersion: 1,
    files: [{ path: filePath, content: serializeJson(document) }],
  })
}

/**
 * 构建待落盘的 canonical v2 文档（不写盘）：
 * 乐观冲突检测（方案 §10.3）、legacy 首次升级备份、以及 view 无法表达的
 * source/foreign/特殊插入位置的保留都在此完成，调用方负责在文件锁内调用。
 */
export function buildLorebookViewDocument(
  filePath: string,
  lorebook: Lorebook,
  now = Date.now(),
  expectedRevision?: number,
): CanonicalLorebookDocumentV2 {
  // Legacy 文件在读取时会临时迁移成 v2，但只有磁盘上已经是 v2 时才应递增 revision。
  const previous = readStoredCanonical(filePath)
  if (previous && expectedRevision !== undefined && previous.revision !== expectedRevision) {
    throw new LorebookSaveConflictError(previous.revision, expectedRevision)
  }
  // 首次把 legacy 文件写成 v2 前先备份并记录迁移日志（方案 §10.1）
  if (!previous) ensureLegacyBackupBeforeV2Write(filePath)
  const migrated = migrate(withoutRuntimeMetadata(lorebook), now, previous ? previous.revision + 1 : 1)
  return previous ? preserveCanonicalOnlyFields(previous, { ...migrated, updatedAt: now }) : migrated
}

/** 构建待落盘的 canonical v2 文档（不写盘）：接受 native v1 或 canonical v2，统一成 canonical v2。 */
export function buildLorebookDocumentInput(
  filePath: string,
  value: unknown,
  now = Date.now(),
): CanonicalLorebookDocumentV2 {
  ensureLegacyBackupBeforeV2Write(filePath)
  const canonical = validateCanonicalLorebookV2(value)
  return canonical.valid ? canonical.value : migrate(value, now)
}

/**
 * 保存当前 UI/运行时 Lorebook 视图为 canonical v2。
 * 已存在 v2 时递增 revision，并保留 view 无法表达的 source/foreign/特殊插入位置。
 * expectedRevision 提供时做乐观冲突检测（方案 §10.3）：磁盘 revision 不一致则抛 LorebookSaveConflictError。
 * 内部走 commitLorebookDocument 收口入口（文件 + journal 同事务）。
 */
export function saveLorebookView(
  filePath: string,
  lorebook: Lorebook,
  now = Date.now(),
  expectedRevision?: number,
): CanonicalLorebookDocumentV2 {
  const document = buildLorebookViewDocument(filePath, lorebook, now, expectedRevision)
  commitLorebookDocument(filePath, document)
  return document
}

/** 备份恢复/测试用：接受 native v1 或 canonical v2，并统一写成 canonical v2（内部同一收口入口）。 */
export function saveLorebookDocumentInput(
  filePath: string,
  value: unknown,
  now = Date.now(),
): CanonicalLorebookDocumentV2 {
  const document = buildLorebookDocumentInput(filePath, value, now)
  commitLorebookDocument(filePath, document)
  return document
}
