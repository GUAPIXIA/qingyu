export const CANONICAL_LOREBOOK_SCHEMA = 'qingyu_lorebook' as const
export const CANONICAL_LOREBOOK_VERSION = 2 as const

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export interface LorebookSourceMetadata {
  adapterId: string
  formatVersion?: string
  originalName?: string
  importedAt: number
  contentHash: string
}

export interface LorebookDefaultsV2 {
  scanDepth: number
  recursiveScanning: boolean
  tokenBudget?: number
}

export type LorebookRetrievalMode = 'keyword' | 'semanticPreferred' | 'semanticRequired' | 'hybrid'

export interface LorebookActivationV2 {
  mode: 'constant' | 'conditional'
  budgetTier: 'protected' | 'standard' | 'supplemental'
  primaryKeys: string[]
  secondaryKeys: string[]
  aliases: string[]
  keyLogic: 'any' | 'all'
  secondaryLogic?: 'and_any' | 'and_all' | 'not_any' | 'not_all'
  caseSensitive: boolean
  wholeWords: boolean
  regex: {
    enabled: boolean
    flags: string
  }
  retrieval: LorebookRetrievalMode
}

export type LorebookPromptAnchorV2 =
  | 'before_character'
  | 'after_character'
  | 'before_examples'
  | 'after_examples'
  | 'authors_note_top'
  | 'authors_note_bottom'
  | 'prompt_end'

export type LorebookInsertionV2 =
  | { kind: 'prompt'; anchor: LorebookPromptAnchorV2 }
  | { kind: 'chat'; depth: number; role?: 'system' | 'user' | 'assistant' }
  | { kind: 'outlet'; name: string }
  | { kind: 'custom'; source: string; value: JsonValue }

export type LorebookGenerationTriggerV2 =
  | 'normal'
  | 'continue'
  | 'impersonate'
  | 'swipe'
  | 'regenerate'
  | 'quiet'

export interface LorebookSchedulingV2 {
  order: number
  probability: number
  scanDepth?: number
  recursion: {
    exclude: boolean
    prevent: boolean
    minDepth: number
  }
  groups: Array<{
    name: string
    weight: number
    prioritized: boolean
  }>
  groupScoring: boolean
  sticky?: number
  cooldown?: number
  delay?: number
  ignoreBudget: boolean
  characterFilter?: {
    exclude: boolean
    names: string[]
    tags: string[]
  }
  generationTriggers?: LorebookGenerationTriggerV2[]
}

export interface CanonicalLoreEntryV2 {
  id: string
  sourceId?: string | number
  enabled: boolean
  title?: string
  content: string
  summary?: string
  translation?: string
  activation: LorebookActivationV2
  insertion: LorebookInsertionV2
  scheduling: LorebookSchedulingV2
  foreign?: Record<string, JsonValue>
}

export interface CanonicalLorebookDocumentV2 {
  schema: typeof CANONICAL_LOREBOOK_SCHEMA
  schemaVersion: typeof CANONICAL_LOREBOOK_VERSION
  id: string
  revision: number
  name: string
  description: string
  enabled: boolean
  defaults: LorebookDefaultsV2
  entries: CanonicalLoreEntryV2[]
  source?: LorebookSourceMetadata
  foreign?: Record<string, JsonValue>
  createdAt: number
  updatedAt: number
}

