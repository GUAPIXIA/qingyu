/**
 * 阶段 2 S2-03：跨存储（业务文件 + sync-meta.db journal）持久化事务。
 *
 * 时序（每一步都可崩溃恢复）：
 *   PREPARED          staging 中已落盘「新内容」与「旧内容备份」，并记录 old/new hash
 *   FILES_APPLIED     目标文件已完成原子替换（renameSync）
 *   JOURNAL_COMMITTED entity_heads 与 change_log 已提交
 *
 * 启动恢复按磁盘实际 hash 决定前滚（补写 journal）或回滚（还原旧内容），
 * 不通过「重建 journal」猜测哪一侧是权威（方案 §2 S2-03）。
 */
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import type { SyncEnvelope } from '../../shared/contracts/sync-envelope'
import type { SyncMetaDb } from './syncMeta'

export const FILE_TRANSACTION_VERSION = 1
export const STAGING_ROOT_SEGMENTS = ['data', 'config', '.sync-tx'] as const

export interface StagedFileWrite {
  /** 目标文件绝对路径（必须位于 userDataDir 之内） */
  path: string
  /** 新内容；null 表示删除该文件 */
  content: string | null
  /**
   * true 表示 content 追加到文件末尾（JSONL 消息追加）。
   * 避免追加单条消息时整文件重写（百万消息基线不可接受）。
   * 删除语义优先：content 为 null 时忽略本字段。
   */
  append?: boolean
}

export interface FileTransactionOp {
  /** 相对 userDataDir 的正斜杠路径 */
  rel: string
  kind: 'write' | 'delete' | 'append'
  /** 该 op 在 staging 下的序号（staging/new/<i> 与 staging/old/<i>）；delete 时 new 侧不存在 */
  stagedIndex: number
  oldHash: string | null
  newHash: string | null
  /** append 回滚所需的旧字节长度；非 append 或文件原本不存在时为 null */
  oldSize: number | null
}

export interface FileTransactionIntent {
  kind: 'put' | 'tombstone'
  /**
   * 前滚时用于补写 head/journal。一次文件写可能同时提交多个实体
   * （会话数组、JSONL 消息文件等多实体容器），因此这里是数组。
   */
  envelopes: SyncEnvelope[]
  ops: FileTransactionOp[]
}

export interface ParsedFileTransaction extends FileTransactionIntent {
  id: string
  state: string
}

export function sha256Of(content: string | Buffer): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`
}

/** 文件不存在返回 null（与 op.oldHash/newHash 的 null 语义一致） */
export function hashFileIfExists(filePath: string): string | null {
  if (!existsSync(filePath)) return null
  return sha256Of(readFileSync(filePath))
}

export function stagingDirFor(userDataDir: string, txId: string): string {
  return join(userDataDir, ...STAGING_ROOT_SEGMENTS, txId)
}

/** 绝对路径 → userDataDir 相对路径；越界（含 ..）直接拒绝，防止路径穿越写同步账本 */
export function toRelPath(userDataDir: string, absPath: string): string {
  const rel = relative(userDataDir, absPath)
  if (!rel || rel.startsWith('..') || rel.includes(`..${sep}`) || rel.startsWith(sep)) {
    throw new Error(`事务目标路径越界: ${absPath}`)
  }
  return rel.split(sep).join('/')
}

export function fromRelPath(userDataDir: string, rel: string): string {
  if (!rel || rel.startsWith('/') || rel.startsWith('..') || rel.includes('..')) {
    throw new Error(`非法相对路径: ${rel}`)
  }
  return join(userDataDir, ...rel.split('/'))
}

function serializeIntent(intent: FileTransactionIntent): string {
  return JSON.stringify({
    version: FILE_TRANSACTION_VERSION,
    kind: intent.kind,
    envelopes: intent.envelopes,
    ops: intent.ops,
  })
}

/** 解析 operations_json；格式不认识时返回 null，交由恢复流程保守处理 */
export function parseIntent(operationsJson: string): FileTransactionIntent | null {
  try {
    const parsed = JSON.parse(operationsJson) as {
      version?: number
      kind?: string
      envelopes?: unknown
      ops?: unknown
    }
    if (parsed.version !== FILE_TRANSACTION_VERSION) return null
    if (parsed.kind !== 'put' && parsed.kind !== 'tombstone') return null
    if (!Array.isArray(parsed.ops)) return null
    if (!Array.isArray(parsed.envelopes)) return null
    const ops: FileTransactionOp[] = []
    for (const raw of parsed.ops as Array<Record<string, unknown>>) {
      if (typeof raw.rel !== 'string' || !raw.rel) return null
      if (raw.kind !== 'write' && raw.kind !== 'delete' && raw.kind !== 'append') return null
      const stagedIndex = Number(raw.stagedIndex)
      if (!Number.isInteger(stagedIndex)) return null
      const oldSizeRaw = raw.oldSize
      ops.push({
        rel: raw.rel,
        kind: raw.kind,
        stagedIndex,
        oldHash: raw.oldHash == null ? null : String(raw.oldHash),
        newHash: raw.newHash == null ? null : String(raw.newHash),
        oldSize: oldSizeRaw == null ? null : Number(oldSizeRaw),
      })
    }
    return {
      kind: parsed.kind,
      envelopes: parsed.envelopes as SyncEnvelope[],
      ops,
    }
  } catch {
    return null
  }
}

export interface StageTransactionInput {
  meta: SyncMetaDb
  userDataDir: string
  id: string
  kind: 'put' | 'tombstone'
  envelopes: SyncEnvelope[]
  writes: StagedFileWrite[]
}

/**
 * PREPARED 阶段：把「旧内容备份 + 新内容」落到 staging，并记录 old/new hash。
 * 业务文件此时尚未改动；任何时刻崩溃都可安全丢弃 staging。
 */
export function stageTransaction(input: StageTransactionInput): FileTransactionOp[] {
  const { meta, userDataDir, id, writes } = input
  const staging = stagingDirFor(userDataDir, id)
  rmSync(staging, { recursive: true, force: true })
  const newDir = join(staging, 'new')
  const oldDir = join(staging, 'old')
  mkdirSync(newDir, { recursive: true })
  mkdirSync(oldDir, { recursive: true })

  const ops: FileTransactionOp[] = []
  try {
    writes.forEach((w, index) => {
      const rel = toRelPath(userDataDir, w.path)
      const existing = existsSync(w.path) ? readFileSync(w.path) : null
      const oldHash = existing ? sha256Of(existing) : null
      if (existing) {
        writeFileSync(join(oldDir, String(index)), existing)
      }
      let newHash: string | null = null
      let kind: FileTransactionOp['kind'] = 'write'
      let oldSize: number | null = null
      if (w.content === null) {
        kind = 'delete'
      } else if (w.append) {
        // 只暂存追加片段；newHash 对「旧内容 + 追加片段」整体计算，恢复时仍可判定新旧
        kind = 'append'
        oldSize = existing ? existing.length : null
        writeFileSync(join(newDir, String(index)), w.content, 'utf8')
        const appended = Buffer.from(w.content, 'utf8')
        newHash = sha256Of(existing ? Buffer.concat([existing, appended]) : appended)
      } else {
        writeFileSync(join(newDir, String(index)), w.content, 'utf8')
        newHash = sha256Of(w.content)
      }
      ops.push({ rel, kind, stagedIndex: index, oldHash, newHash, oldSize })
    })

    const oldHashes: Record<string, string | null> = {}
    const newHashes: Record<string, string | null> = {}
    for (const op of ops) {
      oldHashes[op.rel] = op.oldHash
      newHashes[op.rel] = op.newHash
    }

    meta.prepareFileTransaction({
      id,
      operationsJson: serializeIntent({ kind: input.kind, envelopes: input.envelopes, ops }),
      oldHashesJson: JSON.stringify(oldHashes),
      newHashesJson: JSON.stringify(newHashes),
    })
  } catch (err) {
    rmSync(staging, { recursive: true, force: true })
    throw err
  }
  return ops
}

/** FILES_APPLIED 阶段：把 staging/new 原子替换到目标（delete 则删除目标，append 则追加） */
export function applyStagedFiles(userDataDir: string, ops: FileTransactionOp[], txId: string): void {
  const newDir = join(stagingDirFor(userDataDir, txId), 'new')
  for (const op of ops) {
    const target = fromRelPath(userDataDir, op.rel)
    if (op.kind === 'delete') {
      if (existsSync(target)) unlinkSync(target)
      continue
    }
    mkdirSync(dirname(target), { recursive: true })
    if (op.kind === 'append') {
      appendFileSync(target, readFileSync(join(newDir, String(op.stagedIndex))))
      continue
    }
    renameSync(join(newDir, String(op.stagedIndex)), target)
  }
}

export interface RunFileTransactionInput extends StageTransactionInput {
  /** 在 FILES_APPLIED 之后、JOURNAL_COMMITTED 之前调用：写 entity_heads + change_log */
  commitJournal: () => void
}

export interface RunFileTransactionResult {
  ops: FileTransactionOp[]
}

/**
 * 执行一次业务文件写入 + journal 提交。抛错时已尽力回滚磁盘并在 DB 标记 ABORTED。
 */
export function runFileTransaction(input: RunFileTransactionInput): RunFileTransactionResult {
  const { meta, userDataDir, id } = input
  const ops = stageTransaction(input)

  try {
    applyStagedFiles(userDataDir, ops, id)
    meta.markFileTransaction(id, 'FILES_APPLIED')

    input.commitJournal()
    meta.markFileTransaction(id, 'JOURNAL_COMMITTED')
    rmSync(stagingDirFor(userDataDir, id), { recursive: true, force: true })
    return { ops }
  } catch (err) {
    meta.markFileTransaction(id, 'ABORTED')
    rollbackFileTransaction(userDataDir, {
      id,
      state: 'ABORTED',
      kind: input.kind,
      envelopes: input.envelopes,
      ops,
    })
    throw err
  }
}

export interface FileTransactionFacts {
  id: string
  state: string
  kind: 'put' | 'tombstone'
  envelopes: SyncEnvelope[]
  ops: FileTransactionOp[]
}

export type OpDiskState = 'new' | 'old' | 'unexpected'

export function classifyOpOnDisk(userDataDir: string, op: FileTransactionOp): OpDiskState {
  const current = hashFileIfExists(fromRelPath(userDataDir, op.rel))
  if (current === op.newHash) return 'new'
  if (current === op.oldHash) return 'old'
  return 'unexpected'
}

export function classifyTransactionOnDisk(
  userDataDir: string,
  tx: FileTransactionFacts,
): { states: OpDiskState[]; verdict: 'all_new' | 'all_old' | 'mixed' } {
  const states = tx.ops.map((op) => classifyOpOnDisk(userDataDir, op))
  if (states.length === 0) return { states, verdict: 'all_new' }
  if (states.every((s) => s === 'new')) return { states, verdict: 'all_new' }
  if (states.every((s) => s === 'old')) return { states, verdict: 'all_old' }
  return { states, verdict: 'mixed' }
}

/** 失败/回滚：用 staging/old 还原目标文件，然后清理 staging */
export function rollbackFileTransaction(
  userDataDir: string,
  tx: FileTransactionFacts,
): { restored: number; removed: number } {
  const staging = stagingDirFor(userDataDir, tx.id)
  const oldDir = join(staging, 'old')
  let restored = 0
  let removed = 0
  for (const op of tx.ops) {
    const target = fromRelPath(userDataDir, op.rel)
    const backup = join(oldDir, String(op.stagedIndex))
    if (op.kind === 'append') {
      // 追加回滚：截断回旧长度；原本不存在则删除整文件
      if (op.oldSize === null) {
        if (existsSync(target)) {
          unlinkSync(target)
          removed += 1
        }
      } else if (existsSync(target)) {
        truncateSync(target, op.oldSize)
        restored += 1
      }
      continue
    }
    if (op.oldHash === null) {
      if (existsSync(target)) {
        unlinkSync(target)
        removed += 1
      }
      continue
    }
    if (existsSync(backup)) {
      mkdirSync(dirname(target), { recursive: true })
      renameSync(backup, target)
      restored += 1
    }
  }
  rmSync(staging, { recursive: true, force: true })
  return { restored, removed }
}

export function cleanupStaging(userDataDir: string, txId: string): void {
  rmSync(stagingDirFor(userDataDir, txId), { recursive: true, force: true })
}
