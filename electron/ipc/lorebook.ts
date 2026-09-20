import type { IpcMain, Dialog } from 'electron'
import { join } from 'node:path'
import { readFileSync, statSync } from 'node:fs'
import { nanoid } from 'nanoid'
import { DIRS, withFileLock } from '../services/storage'
import { createLogger } from '../services/logger'
import type { Lorebook, LoreEntry } from '../../shared/types'
import type { LorebookImportOptions } from '../../shared/ipc-api'
import type { CanonicalLorebookDocumentV2 } from '../../shared/lorebook/domain/v2'
import { LOREBOOK_IMPORT_LIMITS } from '../../shared/lorebook/limits'
import {
  LOREBOOK_ADAPTER_AMBIGUITY_MARGIN,
  LOREBOOK_ADAPTER_MIN_CONFIDENCE,
} from '../services/lorebookAdapters/registry'
import { markStaleEntries, removeVectorIndex } from '../services/vectorStore'
import { diffLoreEntryEmbeddingIds } from '../../shared/lorebookEmbedding'
import { scheduleLorebookAutoIndex } from './embedding'
import { safeId } from '../utils/pathGuard'
import { unwrapLorebookPayload } from '../services/lorebookImport'
import { listLorebookViews, readLorebookDocument, readLorebookView, buildLorebookDocumentInput, buildLorebookViewDocument, commitLorebookDocument } from '../services/lorebookDocumentStore'
import { exportLorebookWithAdapter, importLorebookWithRegistry, lorebookAdapterRegistry } from '../services/lorebookAdapters/registry'
import { createCompatibilityReport } from '../services/lorebookAdapters/report'
import { importLorebookWithMappingTemplate } from '../services/lorebookAdapters/mappingImport'
import type { LorebookMappingTemplate } from '../../shared/lorebook/adapters/mapping'
import { guessMappingTemplate, isMappingTemplate } from '../../shared/lorebook/adapters/mapping'
import { listLorebookMappingTemplates, removeLorebookMappingTemplate, upsertLorebookMappingTemplate } from '../services/lorebookMappingTemplates'
import { runLorebookHealthCheck } from '../services/lorebookHealthCheck'
import { compileCanonicalLorebookV2 } from '../../shared/lorebook/runtime/compile'
import { deleteThroughDomain } from '../domain/syncDomainService'
import { writeFileAtomic } from '../domain/pcRepository'

const log = createLogger('lorebook')

/**
 * 阶段 2 S2-04：导入产生的 canonical v2 文档经收口入口落盘，
 * 业务文件字节与 journal 在同一持久化事务中提交（flag 关闭时退化为原原子直写）。
 */
function saveImportedLorebookDocument(document: CanonicalLorebookDocumentV2): void {
  const filePath = join(DIRS.lorebooks(), `${document.id}.json`)
  commitLorebookDocument(filePath, buildLorebookDocumentInput(filePath, document))
  scheduleLorebookAutoIndex(document.id, document.entries.map((entry) => entry.id))
}

export function registerLorebookIPC(ipcMain: IpcMain, dialog: Dialog): void {
  // 列表
  ipcMain.handle('lorebook:list', async () => {
    return await listLorebookViews(DIRS.lorebooks())
  })

  // 保存（条目内容变化时自动标记向量索引过期，语义检索会跳过过期条目）
  // expectedRevision 提供时做乐观冲突检测（方案 §10.3）：磁盘已被其他窗口更新则抛冲突错误。
  ipcMain.handle('lorebook:save', async (_e, lorebook: Lorebook, expectedRevision?: number) => {
    safeId(lorebook.id)
    const filePath = join(DIRS.lorebooks(), `${lorebook.id}.json`)
    let savedRevision = 1
    let changedIds: string[] = []
    // NEW-M5：读-改-写整体持锁，避免并发保存互相覆盖
    await withFileLock(filePath, () => {
      const prev = readLorebookView(filePath)
      // 阶段 2 S2-04：锁内构建 canonical v2 文档（乐观冲突检测），
      // 再由收口入口把文件字节与 journal 在同一事务提交
      const document = buildLorebookViewDocument(filePath, lorebook, Date.now(), expectedRevision)
      commitLorebookDocument(filePath, document)
      savedRevision = document.revision
      // 对所有向量空间统一失效；不能用默认远程路径是否存在作为本地索引的前置条件。
      changedIds = diffSemanticEntries(prev?.entries ?? [], lorebook.entries)
      markStaleEntries(lorebook.id, changedIds)
    })
    scheduleLorebookAutoIndex(lorebook.id, changedIds)
    log.info('世界书已保存', {
      id: lorebook.id,
      name: lorebook.name,
      entries: lorebook.entries.length,
      revision: savedRevision,
      ...(expectedRevision !== undefined ? { expectedRevision } : {}),
    })
    return { revision: savedRevision }
  })

  // 删除
  ipcMain.handle('lorebook:delete', async (_e, id: string) => {
    safeId(id)
    // 阶段 2 S2-04：删除 = tombstone + 业务文件删除，同一持久化事务提交（不再裸 unlink）
    deleteThroughDomain({
      domain: 'lorebook',
      entityType: 'lorebook',
      entityId: id,
      files: [{ path: join(DIRS.lorebooks(), `${id}.json`), content: null }],
    })
    // N5 修复：同步清理向量索引（磁盘文件 + 内存缓存），避免残留垃圾
    removeVectorIndex(id)
    log.info('世界书已删除', { id })
  })

  // 导入
  // 歧义确认期间在主进程内存中缓存导入源（renderer 不接触文件路径），用户选择格式后用 pendingId 完成导入。
  const pendingImports = new Map<string, { parsed: unknown; fileName: string; at: number }>()

  function prunePendingImports(): void {
    for (const [key, value] of pendingImports) {
      if (pendingImports.size > 5 || Date.now() - value.at > 30 * 60_000) pendingImports.delete(key)
    }
  }

  function readImportFile(sourcePath: string): string {
    // 方案 §15：限制导入文件大小，避免超大 JSON 拖垮主进程
    const size = statSync(sourcePath).size
    if (size > LOREBOOK_IMPORT_LIMITS.maxFileBytes) {
      throw new Error(
        `导入文件 ${Math.round(size / 1024 / 1024)} MB 超过大小限制（${Math.round(LOREBOOK_IMPORT_LIMITS.maxFileBytes / 1024 / 1024)} MB）`,
      )
    }
    return readFileSync(sourcePath, 'utf-8')
  }

  const importJsonDetailed = async (options?: LorebookImportOptions) => {
    let parsed: unknown
    let fileName = ''
    if (options?.pendingId) {
      const source = pendingImports.get(options.pendingId)
      if (!source) throw new Error('导入任务已过期，请重新选择文件')
      pendingImports.delete(options.pendingId)
      parsed = source.parsed
      fileName = source.fileName
    } else {
      const result = await dialog.showOpenDialog({
        title: '导入世界书',
        filters: [{ name: 'JSON 文件', extensions: ['json'] }],
        properties: ['openFile'],
      })
      if (result.canceled || result.filePaths.length === 0) return null

      const sourcePath = result.filePaths[0]
      fileName = sourcePath.split(/[\\/]/).pop() ?? ''
      const raw = readImportFile(sourcePath)

      // 格式校验
      try {
        parsed = JSON.parse(raw)
      } catch {
        throw new Error('文件格式错误：不是有效的 JSON 文件')
      }
    }

    // 校验基本结构
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('文件格式错误：JSON 顶层必须是对象')
    }

    // 统一兼容轻语原生、SillyTavern、CCv2/CCv3 character_book 与 lorebook_v3。
    // NEW-H2 修复：导入文件的 id 必须先通过 safeId 校验（防止路径遍历字符写入任意位置）；
    // 非法时回退为新生成的 nanoid
    const payload = unwrapLorebookPayload(parsed)
    let importedId: string
    try {
      importedId = typeof payload.id === 'string' && payload.id ? safeId(payload.id) : nanoid()
    } catch {
      importedId = nanoid()
    }
    const fileMeta = { fileName, extension: 'json' }
    const fallbackName = fileName.replace(/\.json$/i, '').trim() || '导入的世界书'

    // 方案 §6.1：多证据打分后，前两名分差过小时不静默猜测，返回候选让用户选择。
    if (!options?.adapterId) {
      const candidates = lorebookAdapterRegistry.detect(parsed, fileMeta)
      const top = candidates[0]
      if (!top || top.detection.confidence < LOREBOOK_ADAPTER_MIN_CONFIDENCE) {
        throw new Error('无法识别世界书格式；如果知道文件结构，可使用「映射向导导入」手动指定字段路径')
      }
      const second = candidates[1]
      if (
        second
        && second.detection.confidence >= LOREBOOK_ADAPTER_MIN_CONFIDENCE
        && second.detection.confidence >= top.detection.confidence - LOREBOOK_ADAPTER_AMBIGUITY_MARGIN
      ) {
        const pendingId = nanoid()
        pendingImports.set(pendingId, { parsed, fileName, at: Date.now() })
        prunePendingImports()
        return {
          needsFormatChoice: true as const,
          pendingId,
          fileName,
          candidates: candidates.map((item) => ({
            adapterId: item.detection.adapterId,
            formatLabel: item.detection.formatLabel,
            confidence: item.detection.confidence,
          })),
        }
      }
    }

    // 书名 fallback：ST 独立世界书 JSON 通常无 name 字段，用文件名（去扩展名）代替，
    // 避免「导入的世界书」批量重名
    const imported = importLorebookWithRegistry(parsed, {
      id: importedId,
      fallbackName,
      file: fileMeta,
      ...(options?.adapterId ? { adapterId: options.adapterId } : {}),
    })
    saveImportedLorebookDocument(imported.document)
    const lorebook = compileCanonicalLorebookV2(imported.document)
    log.info('世界书已导入', {
      name: lorebook.name,
      entries: lorebook.entries.length,
      adapter: imported.detection.adapterId,
      confidence: imported.detection.confidence,
      compatibility: imported.report.status,
    })
    return { lorebook, detection: imported.detection, report: imported.report }
  }
  ipcMain.handle('lorebook:importJsonDetailed', (_e, options?: LorebookImportOptions) => importJsonDetailed(options))

  // ===================== 阶段 6 P2：映射向导 =====================
  // 打开的导入源在主进程内存中短暂缓存（renderer 不接触文件路径），
  // 用户在向导中编辑模板后用 sourceId 完成导入。
  const mappingSources = new Map<string, { raw: unknown; fileName: string; at: number }>()

  function truncateForPreview(value: unknown, depth = 0): unknown {
    if (Array.isArray(value)) {
      if (depth >= 6) return '…'
      return value.slice(0, 3).map((item) => truncateForPreview(item, depth + 1))
    }
    if (value && typeof value === 'object') {
      if (depth >= 6) return '…'
      return Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .map(([key, item]) => [key, truncateForPreview(item, depth + 1)]))
    }
    if (typeof value === 'string' && value.length > 200) return `${value.slice(0, 200)}…`
    return value
  }

  ipcMain.handle('lorebook:openMappingSource', async () => {
    const result = await dialog.showOpenDialog({
      title: '映射向导导入世界书',
      filters: [{ name: 'JSON 文件', extensions: ['json'] }],
      properties: ['openFile'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const sourcePath = result.filePaths[0]
    const raw = readImportFile(sourcePath)
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error('文件格式错误：不是有效的 JSON 文件')
    }
    const sourceId = nanoid()
    mappingSources.set(sourceId, { raw: parsed, fileName: sourcePath.split(/[\\/]/).pop() ?? '', at: Date.now() })
    // 只保留最近 5 个导入源，防止内存滞留
    for (const [key, value] of mappingSources) {
      if (mappingSources.size > 5 || Date.now() - value.at > 30 * 60_000) mappingSources.delete(key)
    }
    const guessedTemplate = guessMappingTemplate(parsed)
    return {
      sourceId,
      fileName: mappingSources.get(sourceId)!.fileName,
      preview: truncateForPreview(parsed),
      guessedTemplate,
    }
  })

  ipcMain.handle('lorebook:importWithTemplate', (_e, sourceId: string, template: LorebookMappingTemplate) => {
    const source = mappingSources.get(sourceId)
    if (!source) throw new Error('导入源已过期，请重新选择文件')
    if (!isMappingTemplate(template)) throw new Error('映射模板结构不合法')
    const importedId = nanoid()
    const mapped = importLorebookWithMappingTemplate(source.raw, template, {
      id: importedId,
      fallbackName: source.fileName.replace(/\.json$/i, '').trim() || '导入的世界书',
    })
    if (mapped.summary.rejected > 0) {
      throw new Error(`映射导入失败：${mapped.issues.find((item) => item.action === 'rejected')?.message ?? '结构不合法'}`)
    }
    saveImportedLorebookDocument(mapped.document)
    const lorebook = compileCanonicalLorebookV2(mapped.document)
    const report = createCompatibilityReport(`mapping.${template.id}`, `映射模板：${template.name}`, 'template', mapped.issues)
    log.info('世界书已通过映射模板导入', {
      name: lorebook.name,
      entries: lorebook.entries.length,
      template: template.name,
      compatibility: report.status,
    })
    return {
      lorebook,
      detection: {
        adapterId: `mapping.${template.id}`,
        formatLabel: `映射模板：${template.name}`,
        formatVersion: 'template',
        confidence: 100,
        reasons: [`按模板 ${template.name} 映射 ${mapped.summary.mapped} 个字段`],
        conflicts: [],
      },
      report,
    }
  })

  // 阶段 7：一次性数据健康检查（重复 ID / 非法正则 / 死条目 / 无法执行的位置 / stale 索引）
  ipcMain.handle('lorebook:healthCheck', async () => runLorebookHealthCheck())

  ipcMain.handle('lorebook:listMappingTemplates', async () => listLorebookMappingTemplates())
  ipcMain.handle('lorebook:saveMappingTemplate', (_e, template: LorebookMappingTemplate) => {
    if (!isMappingTemplate(template)) throw new Error('映射模板结构不合法')
    upsertLorebookMappingTemplate({ ...template, id: template.id === 'guess' ? nanoid() : template.id })
  })
  ipcMain.handle('lorebook:deleteMappingTemplate', (_e, id: string) => removeLorebookMappingTemplate(id))


  // 导出：默认回到来源 adapter；来源不可用时导出 canonical v2。
  ipcMain.handle('lorebook:exportJson', async (_e, id: string, requestedAdapterId?: string) => {
    safeId(id)
    const document = readLorebookDocument(join(DIRS.lorebooks(), `${id}.json`))
    if (!document) throw new Error('世界书不存在或文件已损坏')
    const sourceAdapterId = document.source?.adapterId
    const adapterId = requestedAdapterId && lorebookAdapterRegistry.get(requestedAdapterId)
      ? requestedAdapterId
      : sourceAdapterId && lorebookAdapterRegistry.get(sourceAdapterId)
        ? sourceAdapterId
        : 'qingyu.canonical-v2'
    const exported = exportLorebookWithAdapter(adapterId, document)
    const safeName = [...document.name]
      .map((char) => char.charCodeAt(0) < 32 ? '_' : char)
      .join('')
      .replace(/[<>:"/\\|?*]/g, '_')
      .trim() || document.id
    const result = await dialog.showSaveDialog({
      title: '导出世界书',
      defaultPath: `${safeName}.json`,
      filters: [{ name: 'JSON 文件', extensions: ['json'] }],
    })
    if (result.canceled || !result.filePath) return { ok: false, canceled: true }
    const outputPath = result.filePath.toLowerCase().endsWith('.json') ? result.filePath : `${result.filePath}.json`
    // 导出目标是用户选择的路径，位于同步域数据目录之外、不属于同步实体：
    // 不写 journal，但仍走统一原子写工具（同目录 tmp + rename），不使用原始写函数。
    writeFileAtomic(outputPath, JSON.stringify(exported.value, null, 2))
    log.info('世界书已导出', { id, adapter: adapterId, path: outputPath })
    return { ok: true, path: outputPath, adapterId, report: exported.report }
  })
}

/** 对比新旧条目的完整向量文档与语义资格，包含标题、关键词、摘要、正文及新增/删除。 */
export function diffSemanticEntries(prev: LoreEntry[], next: LoreEntry[]): string[] {
  return diffLoreEntryEmbeddingIds(prev, next)
}
