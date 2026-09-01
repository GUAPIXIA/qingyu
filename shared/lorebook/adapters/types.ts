import type { CanonicalLorebookDocumentV2, JsonValue } from '../domain/v2'

export interface LorebookFileMetadata {
  fileName?: string
  extension?: string
}

export interface LorebookDetectionResult {
  adapterId: string
  formatLabel: string
  formatVersion: string
  confidence: number
  reasons: string[]
  conflicts: string[]
}

export type CompatibilitySeverity = 'info' | 'warning' | 'error'
export type CompatibilityAction = 'mapped' | 'preserved' | 'approximated' | 'dropped' | 'rejected'

export interface LorebookCompatibilityIssue {
  severity: CompatibilitySeverity
  action: CompatibilityAction
  code: string
  path: string
  message: string
}

export interface LorebookCompatibilityReport {
  adapterId: string
  formatLabel: string
  formatVersion: string
  status: 'exact' | 'preserved' | 'approximated' | 'rejected'
  issues: LorebookCompatibilityIssue[]
  summary: {
    mapped: number
    preserved: number
    approximated: number
    dropped: number
    rejected: number
    warnings: number
    errors: number
  }
}

export interface LorebookImportContext {
  id?: string
  fallbackName: string
  now: number
  contentHash: string
  file?: LorebookFileMetadata
}

export interface LorebookExportContext {
  file?: LorebookFileMetadata
}

export interface LorebookAdapterImportResult {
  document: CanonicalLorebookDocumentV2
  report: LorebookCompatibilityReport
}

export interface LorebookAdapterExportResult {
  value: JsonValue
  report: LorebookCompatibilityReport
}

export interface LorebookFormatAdapter {
  readonly id: string
  readonly label: string
  readonly formatVersion: string
  readonly priority: number

  detect(input: unknown, file?: LorebookFileMetadata): LorebookDetectionResult
  import(input: unknown, context: LorebookImportContext): LorebookAdapterImportResult
  export(document: CanonicalLorebookDocumentV2, context?: LorebookExportContext): LorebookAdapterExportResult
}

export interface LorebookRegistryImportResult extends LorebookAdapterImportResult {
  detection: LorebookDetectionResult
}
