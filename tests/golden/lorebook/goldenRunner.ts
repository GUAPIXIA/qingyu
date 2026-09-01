import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { LorebookTriggerOptions, LorebookTriggerResult } from '../../../src/utils/lorebook'
import { executeLorebookRuntime } from '../../../src/utils/lorebook'

export interface LorebookGoldenFixture {
  id: string
  description: string
  input: LorebookTriggerOptions
  expected: LorebookGoldenOutput
}

export interface LorebookGoldenOutput {
  beforeChar: string[]
  afterChar: string[]
  atEnd: string[]
  atDepth: Array<{ content: string; order: number; depth: number; role?: string }>
  triggeredCount: number
  droppedCount: number
  alwaysDropped: number
  conditionalDropped: number
  detailDropped: number
  bookBudgetDropped: number | null
  triggeredEntryKeys: string[]
  diagnostics: null | {
    summary: {
      activeBooks: number
      enabledEntries: number
      matchedEntries: number
      injectedEntries: number
      droppedEntries: number
      untriggeredEntries: number
      semanticDeadEntries: number
      bookBudgetDropped: number
      globalBudgetDropped: number
    }
    semantic: {
      enabled: boolean | null
      candidateCount: number
    }
    entries: Array<{
      key: string
      outcome: string
      stage: string
      reason: string | null
      activationSource: string | null
      position: string
      depth: number | null
      role: string | null
      priority: string
      recursionDepth: number | null
      matchedKeywords: Array<{ keyword: string; count: number; channel: string }>
      score: number | null
      semanticScore: number | null
      semanticSource: string | null
    }>
  }
}

export function listLorebookGoldenFixtures(dir = join(__dirname, 'fixtures')): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => join(dir, entry.name))
    .sort()
}

export function loadLorebookGoldenFixture(path: string): LorebookGoldenFixture {
  const value = JSON.parse(readFileSync(path, 'utf8')) as LorebookGoldenFixture
  if (!value.id || !value.description || !value.input || value.expected === undefined) {
    throw new Error(`世界书 golden fixture 契约缺失: ${path}`)
  }
  return value
}

function finite(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(value * 1_000_000) / 1_000_000
    : null
}

/** 去除时间戳、概率随机数和 token 估算细节，只冻结领域行为。 */
export function normalizeLorebookGoldenResult(result: LorebookTriggerResult): LorebookGoldenOutput {
  return {
    beforeChar: result.beforeChar,
    afterChar: result.afterChar,
    atEnd: result.atEnd,
    atDepth: result.atDepth,
    triggeredCount: result.triggeredCount,
    droppedCount: result.droppedCount,
    alwaysDropped: result.alwaysDropped ?? 0,
    conditionalDropped: result.conditionalDropped ?? 0,
    detailDropped: result.detailDropped ?? 0,
    bookBudgetDropped: result.bookBudgetDropped ?? null,
    triggeredEntryKeys: result.triggeredEntryKeys ?? [],
    diagnostics: result.diagnostics
      ? {
          summary: {
            activeBooks: result.diagnostics.summary.activeBooks,
            enabledEntries: result.diagnostics.summary.enabledEntries,
            matchedEntries: result.diagnostics.summary.matchedEntries,
            injectedEntries: result.diagnostics.summary.injectedEntries,
            droppedEntries: result.diagnostics.summary.droppedEntries,
            untriggeredEntries: result.diagnostics.summary.untriggeredEntries,
            semanticDeadEntries: result.diagnostics.summary.semanticDeadEntries,
            bookBudgetDropped: result.diagnostics.summary.bookBudgetDropped,
            globalBudgetDropped: result.diagnostics.summary.globalBudgetDropped,
          },
          semantic: {
            enabled: result.diagnostics.semantic.enabled ?? null,
            candidateCount: result.diagnostics.semantic.candidateCount,
          },
          entries: result.diagnostics.entries.map((entry) => ({
            key: entry.key,
            outcome: entry.outcome,
            stage: entry.stage,
            reason: entry.reason ?? null,
            activationSource: entry.activationSource ?? null,
            position: entry.position,
            depth: entry.depth ?? null,
            role: entry.role ?? null,
            priority: entry.priority,
            recursionDepth: entry.recursionDepth ?? null,
            matchedKeywords: entry.matchedKeywords ?? [],
            score: finite(entry.score),
            semanticScore: finite(entry.semanticScore),
            semanticSource: entry.semanticSource ?? null,
          })),
        }
      : null,
  }
}

export function runLorebookGoldenFixture(fixture: LorebookGoldenFixture): LorebookGoldenOutput {
  return normalizeLorebookGoldenResult(executeLorebookRuntime(fixture.input))
}

