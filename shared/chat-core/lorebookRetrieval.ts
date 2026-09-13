import type { Lorebook, LoreEntry } from '../types'

export const LEXICAL_ANALYZER_VERSION = 'unicode-bigram-v1'

export type RetrievalChannel = 'keyword' | 'lexical' | 'vector'

export interface RetrievalAvailability {
  available: boolean
  reason?: string
}

export interface LexicalRetrievalHit {
  key: string
  bookId: string
  entryId: string
  rank: number
  score: number
  rawScore: number
  matchedTokens: string[]
}

export interface LexicalRetrievalQuery {
  query: string
  lorebooks: Lorebook[]
  topK?: number
  threshold?: number
}

export interface IndexChange {
  bookId: string
}

export interface RetrievalProvider {
  readonly id: string
  available(): RetrievalAvailability
  ensureIndex(lorebooks: Lorebook[]): void
  search(query: LexicalRetrievalQuery): LexicalRetrievalHit[]
  invalidate(changes?: IndexChange[]): void
}

interface IndexedEntry {
  key: string
  bookId: string
  entryId: string
  length: number
  terms: Map<string, number>
}

interface LexicalIndex {
  fingerprint: string
  entries: IndexedEntry[]
  documentFrequency: Map<string, number>
  averageLength: number
}

const FIELD_WEIGHTS = {
  title: 4,
  keywords: 3.5,
  summary: 2,
  content: 1,
} as const

const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu
const LATIN_TOKEN = /[\p{Script=Latin}\p{N}]+/gu
const DEFAULT_TOP_K = 24
const DEFAULT_THRESHOLD = 0.08

function normalizeText(text: string): string {
  return text
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
}

/** 拉丁词按词切分；中日韩无空格文本使用 bigram/trigram，单字查询保留 unigram。 */
export function tokenizeLexicalText(text: string): string[] {
  const normalized = normalizeText(text)
  const tokens: string[] = []
  const cjkRanges: Array<[number, number]> = []
  for (const match of normalized.matchAll(CJK_RUN)) {
    const run = match[0]
    const start = match.index ?? 0
    cjkRanges.push([start, start + run.length])
    if (run.length === 1) {
      tokens.push(run)
      continue
    }
    for (let size = 2; size <= 3; size++) {
      if (run.length < size) continue
      for (let index = 0; index <= run.length - size; index++) {
        tokens.push(run.slice(index, index + size))
      }
    }
  }

  const latinOnly = cjkRanges.reduceRight(
    (value, [start, end]) => `${value.slice(0, start)} ${value.slice(end)}`,
    normalized,
  )
  for (const match of latinOnly.matchAll(LATIN_TOKEN)) {
    if (match[0].length >= 2 || /^\d+$/.test(match[0])) tokens.push(match[0])
  }
  return tokens
}

function addFieldTerms(target: Map<string, number>, text: string | undefined, weight: number): number {
  if (!text) return 0
  const tokens = tokenizeLexicalText(text)
  for (const token of tokens) target.set(token, (target.get(token) ?? 0) + weight)
  return tokens.length * weight
}

function entryKey(bookId: string, entry: LoreEntry): string {
  return `${bookId}:${entry.id || entry.keywords.join(',')}`
}

function hashText(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function corpusFingerprint(lorebooks: Lorebook[]): string {
  return lorebooks
    .filter((book) => book?.enabled)
    .map((book) => {
      const revision = book.runtime?.revision
      if (revision !== undefined) return `${book.id}@${revision}`
      return `${book.id}@${hashText(book.entries.map((entry) => [
        entry.id,
        entry.enabled,
        entry.runtime?.title,
        entry.keywords,
        entry.summary,
        entry.content,
      ]).map((part) => JSON.stringify(part)).join('|'))}`
    })
    .sort()
    .join(';')
}

function buildIndex(lorebooks: Lorebook[], fingerprint: string): LexicalIndex {
  const entries: IndexedEntry[] = []
  for (const book of lorebooks) {
    if (!book?.enabled) continue
    for (const entry of book.entries) {
      if (!entry.enabled || !entry.content.trim()) continue
      const terms = new Map<string, number>()
      let length = 0
      length += addFieldTerms(terms, entry.runtime?.title, FIELD_WEIGHTS.title)
      length += addFieldTerms(terms, entry.keywords.join(' '), FIELD_WEIGHTS.keywords)
      length += addFieldTerms(terms, entry.summary, FIELD_WEIGHTS.summary)
      length += addFieldTerms(terms, entry.content, FIELD_WEIGHTS.content)
      if (terms.size === 0) continue
      entries.push({
        key: entryKey(book.id, entry),
        bookId: book.id,
        entryId: entry.id,
        length: Math.max(1, length),
        terms,
      })
    }
  }

  const documentFrequency = new Map<string, number>()
  for (const entry of entries) {
    for (const term of entry.terms.keys()) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1)
    }
  }
  const averageLength = entries.length > 0
    ? entries.reduce((sum, entry) => sum + entry.length, 0) / entries.length
    : 1
  return { fingerprint, entries, documentFrequency, averageLength }
}

/** 无原生依赖的内存 BM25 provider；索引是可删除重建的缓存，不属于世界书主数据。 */
export class LexicalRetrievalProvider implements RetrievalProvider {
  readonly id = `local.lexical.${LEXICAL_ANALYZER_VERSION}`
  private index: LexicalIndex | null = null

  available(): RetrievalAvailability {
    return { available: true }
  }

  ensureIndex(lorebooks: Lorebook[]): void {
    const fingerprint = corpusFingerprint(lorebooks)
    if (this.index?.fingerprint === fingerprint) return
    this.index = buildIndex(lorebooks, fingerprint)
  }

  search({ query, lorebooks, topK = DEFAULT_TOP_K, threshold = DEFAULT_THRESHOLD }: LexicalRetrievalQuery): LexicalRetrievalHit[] {
    this.ensureIndex(lorebooks)
    const index = this.index
    if (!index || index.entries.length === 0) return []
    const queryTokens = [...new Set(tokenizeLexicalText(query))]
    if (queryTokens.length === 0) return []

    const documentCount = index.entries.length
    const k1 = 1.2
    const b = 0.75
    const hits = index.entries.flatMap((entry) => {
      let rawScore = 0
      const matchedTokens: string[] = []
      for (const token of queryTokens) {
        const termFrequency = entry.terms.get(token) ?? 0
        if (termFrequency <= 0) continue
        matchedTokens.push(token)
        const df = index.documentFrequency.get(token) ?? 0
        const inverseDocumentFrequency = Math.log(1 + (documentCount - df + 0.5) / (df + 0.5))
        const lengthNorm = termFrequency + k1 * (1 - b + b * entry.length / index.averageLength)
        rawScore += inverseDocumentFrequency * (termFrequency * (k1 + 1)) / lengthNorm
      }
      if (matchedTokens.length === 0) return []
      const coverage = matchedTokens.length / queryTokens.length
      const score = (rawScore / (rawScore + 6)) * (0.6 + 0.4 * coverage)
      if (score < threshold) return []
      return [{ ...entry, score, rawScore, matchedTokens }]
    })
      .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
      .slice(0, Math.max(1, Math.floor(topK)))

    return hits.map((hit, index) => ({
      key: hit.key,
      bookId: hit.bookId,
      entryId: hit.entryId,
      rank: index + 1,
      score: hit.score,
      rawScore: hit.rawScore,
      matchedTokens: hit.matchedTokens,
    }))
  }

  invalidate(changes?: IndexChange[]): void {
    if (!changes || changes.length > 0) this.index = null
  }
}

export interface RankedRetrievalHit {
  key: string
  score: number
}

export interface FusedRetrievalHit {
  key: string
  /** 原始 RRF 分数：Σ 通道权重 / (k + rank)，量纲随权重与 k 变化。 */
  score: number
  /** 归一化 RRF 分数（0-1）：以“所有通道都排名第 1”的理论最大值为基准。 */
  normalizedScore: number
  ranks: Partial<Record<RetrievalChannel, number>>
  scores: Partial<Record<RetrievalChannel, number>>
}

/** 加权 Reciprocal Rank Fusion；各通道只使用 rank，避免混加 BM25 与余弦分数。 */
export function reciprocalRankFusion(
  channels: Partial<Record<RetrievalChannel, RankedRetrievalHit[]>>,
  options?: {
    k?: number
    weights?: Partial<Record<RetrievalChannel, number>>
  },
): FusedRetrievalHit[] {
  const k = Math.max(1, options?.k ?? 60)
  const weights: Record<RetrievalChannel, number> = {
    keyword: options?.weights?.keyword ?? 3,
    lexical: options?.weights?.lexical ?? 1.5,
    vector: options?.weights?.vector ?? 2,
  }
  const maxScore = (weights.keyword + weights.lexical + weights.vector) / (k + 1)
  const fused = new Map<string, FusedRetrievalHit>()
  for (const channel of ['keyword', 'lexical', 'vector'] as const) {
    channels[channel]?.forEach((hit, index) => {
      const rank = index + 1
      const current = fused.get(hit.key) ?? {
        key: hit.key,
        score: 0,
        normalizedScore: 0,
        ranks: {},
        scores: {},
      }
      current.score += weights[channel] / (k + rank)
      current.normalizedScore = Math.min(1, current.score / maxScore)
      current.ranks[channel] = rank
      current.scores[channel] = hit.score
      fused.set(hit.key, current)
    })
  }
  return [...fused.values()].sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
}

export const defaultLexicalRetrievalProvider = new LexicalRetrievalProvider()
