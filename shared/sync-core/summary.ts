import { compareVectors, type VersionVector } from '../contracts/version-vector'
import { canonicalize, sha256HexUtf8 } from '../contracts/canonical-json'
import type { EntityHeadSummary } from './types'
import { headsRootHash } from './plan'

/**
 * S7-02：同步摘要与高效扫描。
 *
 * - Repository 从 journal/entity_heads 生成摘要，不扫描全部 payload。
 * - 摘要按 entityType 分区，支持分页和 root hash 快速判等。
 * - 首次同步可发送全量 head，后续使用 peer receipt/known vector 增量。
 * - 纯函数：heads 由调用方注入（来自 DB 分页查询），本层不读盘。
 */

export interface SummaryPage {
  entityType: string
  heads: EntityHeadSummary[]
  page: number
  pageSize: number
  hasMore: boolean
  /** 本页 root hash */
  pageHash: string
}

export interface PartitionedSummary {
  /** entityType → 分区 root hash */
  partitionHashes: Record<string, string>
  /** 全量 root hash（与 headsRootHash 一致） */
  rootHash: string
  totalCount: number
  byType: Record<string, number>
}

export interface IncrementalFilter {
  /** 对方已知的本端版本；缺省视为对方一无所知（全量） */
  peerKnown?: VersionVector
  /**
   * true = 只保留「本端版本不被 peerKnown 支配」的 head（需要上传的增量）。
   * false = 只保留「peerKnown 支配本端」的（对方已有，可跳过）。
   */
  onlyUnknownToPeer?: boolean
}

/**
 * 按 entityType 分区生成摘要（内存有界：调用方分页喂入）。
 * `pageHash` / `rootHash` 用于快速判等，不传正文。
 */
export function summarizeHeads(heads: readonly EntityHeadSummary[]): PartitionedSummary {
  const byTypeCounts: Record<string, number> = {}
  const byType: Record<string, EntityHeadSummary[]> = {}
  for (const h of heads) {
    byTypeCounts[h.entityType] = (byTypeCounts[h.entityType] ?? 0) + 1
    const list = byType[h.entityType] ?? []
    list.push(h)
    byType[h.entityType] = list
  }
  const partitionHashes: Record<string, string> = {}
  for (const type of Object.keys(byType).sort()) {
    partitionHashes[type] = headsRootHash(byType[type])
  }
  return {
    partitionHashes,
    rootHash: headsRootHash(heads),
    totalCount: heads.length,
    byType: byTypeCounts,
  }
}

export function pageHash(heads: readonly EntityHeadSummary[]): string {
  return headsRootHash(heads)
}

/**
 * 增量过滤：只保留 peer 尚未见过（或版本更新）的 head。
 * 判定：compareVectors(local, peerKnown[entity]) 为 dominates/concurrent，
 * 或 peerKnown 缺席该设备分量且 local 有新增。
 * 简化口径（与 plan 的 upload 分类一致）：local 不被 peerKnown 支配 → 需上传。
 */
export function filterIncremental(
  heads: readonly EntityHeadSummary[],
  filter: IncrementalFilter,
): EntityHeadSummary[] {
  const peerKnown = filter.peerKnown ?? {}
  const onlyUnknown = filter.onlyUnknownToPeer !== false
  return heads.filter((h) => {
    // peer 对该实体的已知程度用整体 known vector 近似：
    // 若 peerKnown 对 h.version 为 dominates 或 equal → 对方已有该版本或更新
    const rel = compareVectors(h.version, peerKnown)
    const peerHas = rel === 'dominated' || rel === 'equal'
    return onlyUnknown != peerHas
  })
}

/**
 * 按 entityType 分页切片（100 万消息场景：每页固定上限，禁止一次载入全部）。
 */
export function paginateByType(
  heads: readonly EntityHeadSummary[],
  entityType: string,
  page: number,
  pageSize: number,
): SummaryPage {
  const filtered = heads.filter((h) => h.entityType === entityType)
  const start = page * pageSize
  const slice = filtered.slice(start, start + pageSize)
  return {
    entityType,
    heads: slice,
    page,
    pageSize,
    hasMore: start + pageSize < filtered.length,
    pageHash: pageHash(slice),
  }
}

/**
 * 摘要 root 快速判等：双方 rootHash 相等 → 无变更，可跳过 plan 细分。
 */
export function summaryEqual(a: PartitionedSummary, b: PartitionedSummary): boolean {
  return a.rootHash === b.rootHash
}

/** 供 plan 展示的 backlog 统计（不暴露正文） */
export interface BacklogStats {
  totalLocalChanges: number
  byType: Record<string, number>
}

export function backlogFromHeads(
  heads: readonly EntityHeadSummary[],
  peerKnown: VersionVector,
): BacklogStats {
  const pending = filterIncremental(heads, { peerKnown, onlyUnknownToPeer: true })
  const byType: Record<string, number> = {}
  for (const h of pending) {
    byType[h.entityType] = (byType[h.entityType] ?? 0) + 1
  }
  return { totalLocalChanges: pending.length, byType }
}

/** 规范序列化（调试/日志用，不含正文） */
export function serializeSummary(s: PartitionedSummary): string {
  return canonicalize(s as never)
}

export function summaryFingerprint(s: PartitionedSummary): string {
  return 'sum:' + sha256HexUtf8(serializeSummary(s))
}
