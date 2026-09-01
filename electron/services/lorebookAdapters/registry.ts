import { createHash } from 'node:crypto'
import type { CanonicalLorebookDocumentV2 } from '../../../shared/lorebook/domain/v2'
import type {
  LorebookAdapterExportResult,
  LorebookFileMetadata,
  LorebookFormatAdapter,
  LorebookRegistryImportResult,
} from '../../../shared/lorebook/adapters/types'
import { canonicalV2Adapter } from './canonicalV2'
import { nativeV1Adapter } from './nativeV1'
import { sillyTavernWorldInfoAdapter } from './sillyTavern'
import { characterBookAdapter } from './characterBook'
import { lorebookV3Adapter } from './lorebookV3'
import { risuLorebookAdapter } from './risu'
import { novelAiLorebookAdapter } from './novelai'
import { agnaiMemoryBookAdapter } from './agnai'
import { compatibilityIssue, createCompatibilityReport } from './report'
import { LorebookAdapterError } from './error'
import { assertImportJsonDepth, enforceImportDocumentLimits } from '../../../shared/lorebook/limits'

/** 识别置信度低于该值时拒绝导入（方案 §6.1：不静默猜测）。 */
export const LOREBOOK_ADAPTER_MIN_CONFIDENCE = 30
/** 前两名检测分差小于该值视为格式歧义，交由用户选择而不是自动挑选。 */
export const LOREBOOK_ADAPTER_AMBIGUITY_MARGIN = 5

export interface ImportWithRegistryOptions {
  id?: string
  fallbackName: string
  file?: LorebookFileMetadata
  now?: number
  contentHash?: string
  /** 用户显式选择的 adapter（歧义确认后使用）；提供时跳过检测直接导入。 */
  adapterId?: string
}

export class LorebookAdapterRegistry {
  private readonly adapters = new Map<string, LorebookFormatAdapter>()

  constructor(adapters: LorebookFormatAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter)
  }

  register(adapter: LorebookFormatAdapter): void {
    if (!adapter.id.trim()) throw new Error('世界书 adapter id 不能为空')
    this.adapters.set(adapter.id, adapter)
  }

  unregister(adapterId: string): void {
    this.adapters.delete(adapterId)
  }

  list(): LorebookFormatAdapter[] {
    return [...this.adapters.values()].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
  }

  get(adapterId: string): LorebookFormatAdapter | undefined {
    return this.adapters.get(adapterId)
  }

  detect(input: unknown, file?: LorebookFileMetadata) {
    return this.list()
      .map((adapter) => ({ adapter, detection: adapter.detect(input, file) }))
      .filter((item) => item.detection.confidence > 0)
      .sort((a, b) => b.detection.confidence - a.detection.confidence
        || b.adapter.priority - a.adapter.priority
        || a.adapter.id.localeCompare(b.adapter.id))
  }

  import(input: unknown, options: ImportWithRegistryOptions): LorebookRegistryImportResult {
    // 方案 §15：超深结构在进入 adapter 前直接拒绝，避免后续遍历栈溢出
    try {
      assertImportJsonDepth(input)
    } catch (error) {
      throw new LorebookAdapterError((error as Error).message)
    }

    const forced = options.adapterId
      ? (() => {
          const adapter = this.adapters.get(options.adapterId!)
          if (!adapter) throw new LorebookAdapterError(`未注册世界书格式适配器：${options.adapterId}`)
          return {
            adapter,
            detection: {
              adapterId: adapter.id,
              formatLabel: adapter.label,
              formatVersion: adapter.formatVersion,
              confidence: 100,
              reasons: ['用户手动指定格式'],
              conflicts: [],
            },
          }
        })()
      : undefined
    const candidates = this.detect(input, options.file)
    const selected = forced ?? candidates[0]
    if (!selected || selected.detection.confidence < LOREBOOK_ADAPTER_MIN_CONFIDENCE) {
      throw new LorebookAdapterError(
        '无法识别世界书格式；如果知道文件结构，可使用「映射向导导入」手动指定字段路径',
      )
    }

    const hash = options.contentHash
      ?? createHash('sha256').update(JSON.stringify(input)).digest('hex')
    const imported = selected.adapter.import(input, {
      id: options.id,
      fallbackName: options.fallbackName,
      now: options.now ?? Date.now(),
      contentHash: hash,
      file: options.file,
    })
    const detectionIssues = [
      ...selected.detection.conflicts.map((message) => compatibilityIssue(
        'warning', 'mapped', 'format_conflict', '$', message,
      )),
    ]
    const alternative = candidates[1]
    if (!forced && alternative && alternative.detection.confidence >= selected.detection.confidence - LOREBOOK_ADAPTER_AMBIGUITY_MARGIN) {
      detectionIssues.push(compatibilityIssue(
        'warning', 'mapped', 'ambiguous_format', '$',
        `格式也接近「${alternative.detection.formatLabel}」(${alternative.detection.confidence}%)，已按优先级选择「${selected.detection.formatLabel}」`,
      ))
    }
    // 方案 §6.5/§15：导入产物统一执行条目数/正文长度/foreign 保留区/正则上限
    const limitIssues = enforceImportDocumentLimits(imported.document)
    const report = createCompatibilityReport(
      imported.report.adapterId,
      imported.report.formatLabel,
      imported.report.formatVersion,
      [...detectionIssues, ...imported.report.issues, ...limitIssues],
    )
    if (report.status === 'rejected') {
      const firstError = report.issues.find((item) => item.severity === 'error')
      throw new LorebookAdapterError(
        `世界书包含无法导入的结构：${firstError?.message ?? '结构不合法'}`,
        report,
      )
    }
    return { document: imported.document, report, detection: selected.detection }
  }

  export(adapterId: string, document: CanonicalLorebookDocumentV2): LorebookAdapterExportResult {
    const adapter = this.adapters.get(adapterId)
    if (!adapter) throw new LorebookAdapterError(`未注册世界书格式适配器：${adapterId}`)
    return adapter.export(document)
  }
}

export const lorebookAdapterRegistry = new LorebookAdapterRegistry([
  canonicalV2Adapter,
  nativeV1Adapter,
  sillyTavernWorldInfoAdapter,
  characterBookAdapter,
  lorebookV3Adapter,
  risuLorebookAdapter,
  novelAiLorebookAdapter,
  agnaiMemoryBookAdapter,
])

export function detectLorebookFormats(input: unknown, file?: LorebookFileMetadata) {
  return lorebookAdapterRegistry.detect(input, file).map((item) => item.detection)
}

export function importLorebookWithRegistry(input: unknown, options: ImportWithRegistryOptions) {
  return lorebookAdapterRegistry.import(input, options)
}

export function exportLorebookWithAdapter(adapterId: string, document: CanonicalLorebookDocumentV2) {
  return lorebookAdapterRegistry.export(adapterId, document)
}

export { LorebookAdapterError } from './error'
