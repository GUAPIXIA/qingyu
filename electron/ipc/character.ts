import type { IpcMain, Dialog } from 'electron'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { createLogger } from '../services/logger'
import { notifyGroupSpatialActorsChanged } from '../services/groupLifecycle'
import { safeSend } from '../utils/safeSend'
import {
  importCharacterFromPng,
  importCharacterFromJson,
  importCardFrontendExtensions,
  exportCharacterToPng,
  exportCharacterToJson,
  exportCharacterCover,
  getCoverExtension,
  saveCharacterThroughDomain,
  listCharacters,
  getCharacter,
  deleteCharacterThroughDomain,
  reloadAvatarFromUrl,
  resolveImportConflict,
  removeCharacterMediaFiles,
  type ImportConflictPolicy,
  type ImportOutcome,
  type ImportResolution,
} from '../services/charCard'
import type { Character, Settings } from '../../shared/types'
import { IPC_EVENTS } from '../../shared/ipc-channels'
import { safeId } from '../utils/pathGuard'
import { DIRS, readJson, withFileLock } from '../services/storage'
import { suggestLorebooks } from '../services/lorebookMatcher'

const log = createLogger('character')

/** 并发池大小 */
const CONCURRENCY_LIMIT = 3

/**
 * UEX-P2-04：进行中的批量导入批次（模块级唯一，天然构成防重入锁）。
 * - controller：中断阶段1封面下载的网络请求
 * - canceled：文件边界处检查的取消标志（新批次开始即重置）
 */
interface ImportBatchState {
  controller: AbortController
  canceled: boolean
}
let currentImportBatch: ImportBatchState | null = null

/**
 * 角色级文件锁：基于角色 JSON 文件路径的串行写队列
 * 防止并发保存/删除同一角色时互相覆盖（修复：此前调用未定义函数导致运行时崩溃）
 */
function withCharacterLock<T>(id: string, fn: () => T | Promise<T>): Promise<T> {
  return withFileLock(join(DIRS.characters(), `${id}.json`), fn)
}

/** 读取当前设置中的封面代理 URL */
function getCoverProxyUrl(): string | undefined {
  try {
    const settings = readJson<Settings>(join(DIRS.config(), 'settings.json'))
    return settings?.coverProxyUrl || undefined
  } catch {
    return undefined
  }
}

/** UEX-P1-17：冲突策略入参归一化——仅显式 'overwrite' 才覆盖，默认（含缺失/非法值）另存副本 */
function normalizeConflictPolicy(value: unknown): ImportConflictPolicy {
  return value === 'overwrite' ? 'overwrite' : 'copy'
}

/** UEX-P1-17：落盘已决策的导入结果（覆盖时先清理旧媒体，避免旧图遮蔽新图），返回前端扩展落地明细 */
async function persistResolvedCharacter(resolution: ImportResolution) {
  const character = resolution.character
  if (resolution.outcome === 'overwritten') removeCharacterMediaFiles(character.id)
  await withCharacterLock(character.id, () => {
    saveCharacterThroughDomain(character)
  })
  // 角色卡前端扩展落地（正则脚本 / 快捷回复）
  return importCardFrontendExtensions(character)
}

type ImportSaveResult =
  | { skipped: true; outcome: ImportOutcome; note: string }
  | { skipped: false; outcome: ImportOutcome; note: string; saved: Character; cardExtras: ReturnType<typeof importCardFrontendExtensions> }

/**
 * UEX-P1-17：单张导入的查重/冲突处理与落盘。
 * 相同 → 跳过（不落盘）；同名异内容 → 副本 / 显式覆盖（覆盖保留原 id 与会话关联）。
 * 注：解析阶段可能已提取内嵌世界书，跳过时不回收（判定不含绑定字段，世界书可被手动复用）。
 */
async function resolveAndSaveImported(character: Character, conflict: ImportConflictPolicy): Promise<ImportSaveResult> {
  const existing = await listCharacters()
  const resolution = resolveImportConflict(character, existing, conflict)
  if (resolution.outcome === 'skippedIdentical') {
    log.info('角色导入已跳过（内容相同）', { name: character.name, note: resolution.note })
    return { skipped: true, outcome: resolution.outcome, note: resolution.note }
  }
  const cardExtras = await persistResolvedCharacter(resolution)
  return { skipped: false, outcome: resolution.outcome, note: resolution.note, saved: resolution.character, cardExtras }
}

export function registerCharacterIPC(ipcMain: IpcMain, dialog: Dialog): void {
  // 列表
  ipcMain.handle('character:list', async () => {
    return await listCharacters()
  })

  // 读取
  ipcMain.handle('character:get', async (_e, id: string) => {
    safeId(id)
    return getCharacter(id)
  })

  // 保存
  ipcMain.handle('character:save', async (_e, character: Character) => {
    safeId(character.id)
    character.updatedAt = Date.now()
    // NEW-M4：持锁保存。S2-04：saveCharacterThroughDomain 内部把角色 JSON 与媒体
    // 连同 journal 在同一事务提交，此处不再额外记账
    await withCharacterLock(character.id, () => {
      saveCharacterThroughDomain(character)
    })
    log.info('角色已保存', { id: character.id, name: character.name })
    notifyGroupSpatialActorsChanged(character.id)
  })

  // 删除
  ipcMain.handle('character:delete', async (_e, id: string) => {
    safeId(id)
    // NEW-M4：持锁删除。S2-04：deleteCharacterThroughDomain 产生 tombstone 并删除聚合文件
    await withCharacterLock(id, () => {
      deleteCharacterThroughDomain(id)
    })
    log.info('角色已删除', { id })
  })

  // 导入 PNG（UEX-P1-17：conflict 为同名冲突策略，默认另存副本，'overwrite' 仅用户显式选择）
  ipcMain.handle('character:importPng', async (event, conflict?: ImportConflictPolicy) => {
    try {
      const result = await dialog.showOpenDialog({
        title: '导入角色卡 (PNG)',
        filters: [{ name: 'PNG 图片', extensions: ['png'] }],
        properties: ['openFile'],
      })
      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, canceled: true }
      }
      const filePath = result.filePaths[0]
      const fileName = filePath.split(/[\\/]/).pop() || filePath

      safeSend(event.sender,IPC_EVENTS.characterImportProgress, {
        current: 1, total: 1, fileName, status: 'processing' as const,
      })

      const proxyUrl = getCoverProxyUrl()
      const character = await importCharacterFromPng(filePath, proxyUrl)
      // UEX-P1-17：查重/冲突策略（相同跳过、冲突副本、显式覆盖）
      const resolution = await resolveAndSaveImported(character, normalizeConflictPolicy(conflict))
      if (resolution.skipped) {
        // 相同卡跳过：不产生新卡，回传明细「已存在相同角色：{name}」
        safeSend(event.sender,IPC_EVENTS.characterImportProgress, {
          current: 1, total: 1, fileName: resolution.note, status: 'done' as const,
        })
        return { success: true, outcome: resolution.outcome, note: resolution.note }
      }
      const saved = resolution.saved
      // 世界书推荐（显式确认，替代旧的静默自动绑定）：角色卡不含内嵌世界书时返回候选
      const lorebookSuggestions = suggestLorebooks(saved)

      safeSend(event.sender,IPC_EVENTS.characterImportProgress, {
        current: 1, total: 1, fileName: saved.name, status: 'done' as const,
      })

      log.info('角色已导入 (PNG)', { id: saved.id, name: saved.name, outcome: resolution.outcome, suggestions: lorebookSuggestions.length })
      return { success: true, character: saved, cardExtras: resolution.cardExtras, lorebookSuggestions, outcome: resolution.outcome, note: resolution.note }
    } catch (e) {
      log.error('导入角色 PNG 失败', { error: (e as Error).message })
      return { success: false, error: (e as Error).message }
    }
  })

  // 导入 JSON（UEX-P1-17：conflict 为同名冲突策略，默认另存副本，'overwrite' 仅用户显式选择）
  ipcMain.handle('character:importJson', async (event, conflict?: ImportConflictPolicy) => {
    try {
      const result = await dialog.showOpenDialog({
        title: '导入角色卡 (JSON)',
        filters: [{ name: 'JSON 文件', extensions: ['json'] }],
        properties: ['openFile'],
      })
      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, canceled: true }
      }
      const filePath = result.filePaths[0]
      const fileName = filePath.split(/[\\/]/).pop() || filePath

      safeSend(event.sender,IPC_EVENTS.characterImportProgress, {
        current: 1, total: 1, fileName, status: 'processing' as const,
      })

      const proxyUrl = getCoverProxyUrl()
      const character = await importCharacterFromJson(filePath, proxyUrl)
      // UEX-P1-17：查重/冲突策略（相同跳过、冲突副本、显式覆盖）
      const resolution = await resolveAndSaveImported(character, normalizeConflictPolicy(conflict))
      if (resolution.skipped) {
        // 相同卡跳过：不产生新卡，回传明细「已存在相同角色：{name}」
        safeSend(event.sender,IPC_EVENTS.characterImportProgress, {
          current: 1, total: 1, fileName: resolution.note, status: 'done' as const,
        })
        return { success: true, outcome: resolution.outcome, note: resolution.note }
      }
      const saved = resolution.saved
      // 世界书推荐（显式确认，替代旧的静默自动绑定）
      const lorebookSuggestions = suggestLorebooks(saved)
      const needAvatar = !saved.avatar

      safeSend(event.sender,IPC_EVENTS.characterImportProgress, {
        current: 1, total: 1, fileName: saved.name, status: 'done' as const,
      })

      log.info('角色已导入 (JSON)', { id: saved.id, name: saved.name, outcome: resolution.outcome, suggestions: lorebookSuggestions.length })
      return { success: true, character: saved, needAvatar, cardExtras: resolution.cardExtras, lorebookSuggestions, outcome: resolution.outcome, note: resolution.note }
    } catch (e) {
      log.error('导入角色 JSON 失败', { error: (e as Error).message })
      return { success: false, error: (e as Error).message }
    }
  })

  // 绑定世界书到角色（导入后由用户从推荐中显式选择，或单独手动设置）
  ipcMain.handle('character:bindLorebook', async (_e, characterId: string, lorebookId: string | null) => {
    safeId(characterId)
    if (lorebookId !== null) {
      safeId(lorebookId)
      // 校验世界书存在
      const lbPath = join(DIRS.lorebooks(), `${lorebookId}.json`)
      if (!existsSync(lbPath)) throw new Error('世界书不存在')
    }
    return withCharacterLock(characterId, async () => {
      const character = getCharacter(characterId)
      if (!character) throw new Error('角色不存在')
      // 新数据结构：boundLorebookIds 列表；lorebookId 保留为兼容字段
      character.boundLorebookIds = lorebookId ? [lorebookId] : []
      character.lorebookId = lorebookId
      character.updatedAt = Date.now()
      saveCharacterThroughDomain(character)
      log.info('角色世界书已更新', { characterId, lorebookId })
    })
  })

  // 导出 PNG（UEX-P1-18：返回 { ok, path?/error? }，导出结果不再静默）
  ipcMain.handle('character:exportPng', async (_e, id: string) => {
    safeId(id)
    const character = getCharacter(id)
    if (!character) throw new Error('角色不存在')
    const result = await dialog.showSaveDialog({
      title: '导出角色卡',
      defaultPath: `${character.name}.png`,
      filters: [{ name: 'PNG 图片', extensions: ['png'] }],
    })
    if (result.canceled || !result.filePath) return { ok: false, canceled: true }
    try {
      exportCharacterToPng(character, result.filePath)
    } catch (e) {
      // UEX-P1-18：写入失败回传原因，不再向上冒泡为静默 IPC reject
      const error = (e as Error).message
      log.warn('角色 PNG 导出失败', { id, error })
      return { ok: false, error }
    }
    log.info('角色已导出 (PNG)', { id, name: character.name, path: result.filePath })
    return { ok: true, path: result.filePath }
  })

  // 导出 JSON（UEX-P1-18：返回 { ok, path?/error? }，导出结果不再静默）
  ipcMain.handle('character:exportJson', async (_e, id: string) => {
    safeId(id)
    const character = getCharacter(id)
    if (!character) throw new Error('角色不存在')
    const result = await dialog.showSaveDialog({
      title: '导出角色卡',
      defaultPath: `${character.name}.json`,
      filters: [{ name: 'JSON 文件', extensions: ['json'] }],
    })
    if (result.canceled || !result.filePath) return { ok: false, canceled: true }
    try {
      exportCharacterToJson(character, result.filePath)
    } catch (e) {
      // UEX-P1-18：写入失败回传原因，不再向上冒泡为静默 IPC reject
      const error = (e as Error).message
      log.warn('角色 JSON 导出失败', { id, error })
      return { ok: false, error }
    }
    log.info('角色已导出 (JSON)', { id, name: character.name, path: result.filePath })
    return { ok: true, path: result.filePath }
  })

  // 导出封面图片
  ipcMain.handle('character:exportCover', async (_e, id: string) => {
    safeId(id)
    const character = getCharacter(id)
    if (!character) throw new Error('角色不存在')
    const ext = getCoverExtension(character)
    if (!ext) return { ok: false, error: '该角色没有可导出的封面图片' }
    const result = await dialog.showSaveDialog({
      title: '导出封面图片',
      defaultPath: `${character.name}-封面.${ext}`,
      filters: [{ name: `${ext.toUpperCase()} 图片`, extensions: [ext] }],
    })
    if (result.canceled || !result.filePath) return { ok: false, canceled: true }
    try {
      exportCharacterCover(character, result.filePath)
    } catch (e) {
      const error = (e as Error).message
      log.warn('角色封面导出失败', { id, error })
      return { ok: false, error }
    }
    log.info('角色封面已导出', { id, name: character.name, path: result.filePath })
    return { ok: true }
  })

  // 批量导入（UEX-P1-17：conflict 为同名冲突策略，默认另存副本，'overwrite' 仅用户显式选择）
  ipcMain.handle('character:importBatch', async (event, conflict?: ImportConflictPolicy) => {
    // UEX-P2-04：防重入兜底——已有导入批次进行中时直接拒绝（UI 侧另有导入入口禁用）
    if (currentImportBatch) {
      return { success: false, error: '已有导入任务进行中' }
    }
    // UEX-P2-04：新批次开始即重置取消状态（全新 AbortController 与取消标志）
    const batch: ImportBatchState = { controller: new AbortController(), canceled: false }
    currentImportBatch = batch
    try {
      const result = await dialog.showOpenDialog({
        title: '批量导入角色卡',
        filters: [
          { name: '角色卡文件', extensions: ['png', 'json'] },
        ],
        properties: ['openFile', 'multiSelections'],
      })
      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, canceled: true }
      }

      const total = result.filePaths.length
      const batchResults: { name: string; success: boolean; error?: string; needAvatar?: boolean; outcome?: ImportOutcome; note?: string }[] = []
      let successCount = 0
      let failCount = 0
      // UEX-P1-17：查重/冲突结果计数（相同跳过 / 副本 / 覆盖）
      let skippedIdenticalCount = 0
      let copiedCount = 0
      let overwrittenCount = 0

      const proxyUrl = getCoverProxyUrl()
      const filePaths = result.filePaths

      // ===== 阶段1: 并行解析所有文件 =====
      interface ParsedFile {
        filePath: string
        fileName: string
        character: Character
      }
      // UEX-P2-04：解析/封面下载阶段补阶段级进度（起始一条 + 每文件解析完成计数）
      let parsedCount = 0
      safeSend(event.sender, IPC_EVENTS.characterImportProgress, {
        current: 0, total, fileName: '解析角色卡中…', status: 'processing' as const,
      })
      const parseResults: (ParsedFile | { filePath: string; fileName: string; error: string } | { filePath: string; fileName: string; skipped: true })[] = await Promise.all(
        filePaths.map(async (filePath) => {
          const fileName = filePath.split(/[\\/]/).pop() || filePath
          // UEX-P2-04：文件边界检查取消标志——已取消则该文件不再解析，计入「未处理」
          if (batch.canceled) return { filePath, fileName, skipped: true as const }
          try {
            const ext = filePath.split('.').pop()?.toLowerCase()
            let character: Character
            if (ext === 'png') {
              // UEX-P2-04：封面下载绑定批次 AbortSignal，取消时中断网络请求
              character = await importCharacterFromPng(filePath, proxyUrl, batch.controller.signal)
            } else if (ext === 'json') {
              character = await importCharacterFromJson(filePath, proxyUrl, batch.controller.signal)
            } else {
              throw new Error('不支持的文件格式')
            }
            // UEX-P2-04：单文件解析完成即上报（含封面下载已在解析内完成）
            parsedCount++
            safeSend(event.sender, IPC_EVENTS.characterImportProgress, {
              current: parsedCount, total, fileName: `解析完成：${fileName}`, status: 'processing' as const,
            })
            return { filePath, fileName, character }
          } catch (e) {
            // UEX-P2-04：解析失败也占用完成计数，进度不失真
            parsedCount++
            safeSend(event.sender, IPC_EVENTS.characterImportProgress, {
              current: parsedCount, total, fileName: `解析失败：${fileName}`, status: 'error' as const,
            })
            return { filePath, fileName, error: (e as Error).message }
          }
        }),
      )

      // 分离成功/失败
      const toImport: ParsedFile[] = []
      const failedParses: { name: string; success: boolean; error: string }[] = []

      for (const r of parseResults) {
        if ('skipped' in r) {
          // UEX-P2-04：取消后未处理的文件不进明细，汇总为「未处理」
          continue
        } else if ('error' in r) {
          failedParses.push({ name: r.fileName, success: false, error: r.error })
          failCount++
        } else {
          toImport.push(r)
        }
      }

      // ===== 阶段2: 并发保存（有网卡下载的已在上一步完成） =====
      let completedCount = failedParses.length

      // ===== 阶段1.5（UEX-P1-17）：顺序查重/冲突决策（文件顺序执行，保证批内去重与副本命名确定性） =====
      interface ResolvedImportItem { item: ParsedFile; resolution: ImportResolution }
      const policy = normalizeConflictPolicy(conflict)
      // 既有角色 + 批内已决策角色（并入后批内重复同样按策略去重：批内相同 → 跳过）
      const known: Character[] = [...(await listCharacters())]
      const resolvedItems: ResolvedImportItem[] = []
      for (const item of toImport) {
        // UEX-P2-04：文件边界检查取消标志——已取消则剩余文件不再决策，计入「未处理」
        if (batch.canceled) break
        const resolution = resolveImportConflict(item.character, known, policy)
        if (resolution.outcome === 'skippedIdentical') {
          // UEX-P1-17：内容相同自动跳过（不产生新卡），明细「已存在相同角色：{name}」
          skippedIdenticalCount++
          completedCount++
          batchResults.push({ name: item.character.name, success: true, outcome: resolution.outcome, note: resolution.note })
          safeSend(event.sender, IPC_EVENTS.characterImportProgress, {
            current: completedCount, total, fileName: resolution.note, status: 'done' as const,
          })
          continue
        }
        // UEX-P1-17：批内去重链——已决策角色并入 known（覆盖时替换旧条目，被覆盖的旧内容不再参与批内判定）
        if (resolution.outcome === 'overwritten') {
          const idx = known.findIndex((c) => c.id === resolution.character.id)
          if (idx >= 0) known.splice(idx, 1, resolution.character)
          else known.push(resolution.character)
        } else {
          known.push(resolution.character)
        }
        resolvedItems.push({ item, resolution })
      }

      // 并发池
      async function runWithPool(items: ResolvedImportItem[], limit: number, fn: (item: ResolvedImportItem) => Promise<{ name: string; success: boolean; error?: string; needAvatar?: boolean; outcome?: ImportOutcome; note?: string }>) {
        const results: { name: string; success: boolean; error?: string; needAvatar?: boolean; outcome?: ImportOutcome; note?: string }[] = []
        let cursor = 0

        async function worker() {
          while (cursor < items.length) {
            // UEX-P2-04：文件边界检查取消标志——已取消则停止后续落盘，剩余计入「未处理」
            if (batch.canceled) return
            const idx = cursor++
            const item = items[idx]
            const r = await fn(item)
            completedCount++
            const status = r.success ? 'done' as const : 'error' as const
            try {
              safeSend(event.sender, IPC_EVENTS.characterImportProgress, {
                current: completedCount, total, fileName: r.name, status,
              })
            } catch {
              // renderer 可能已销毁
            }
            results.push(r)
          }
        }

        const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker())
        await Promise.all(workers)
        return results
      }

      const saveResults = await runWithPool(resolvedItems, CONCURRENCY_LIMIT, async ({ item, resolution }) => {
        const character = resolution.character
        try {
          // UEX-P1-17：副本/覆盖与新卡走同一落盘入口（覆盖保留原 id 与会话关联，覆盖前清理旧媒体）
          await persistResolvedCharacter(resolution)
          const needAvatar = !character.avatar
          return { name: character.name, success: true, needAvatar, outcome: resolution.outcome, note: resolution.note }
        } catch (e) {
          log.error('批量导入保存失败', { fileName: item.fileName, error: (e as Error).message })
          return { name: item.fileName, success: false, error: (e as Error).message }
        }
      })

      for (const r of saveResults) {
        if (r.success) {
          successCount++
          // UEX-P1-17：副本/覆盖计数（只统计实际落盘的，取消前未落盘的计入「未处理」）
          if (r.outcome === 'copied') copiedCount++
          else if (r.outcome === 'overwritten') overwrittenCount++
        }
        else failCount++
      }
      batchResults.push(...failedParses, ...saveResults)

      // UEX-P2-04：取消汇总「已取消：成功 X / 失败 Y / 未处理 Z」；已完成的导入保留（不回滚）
      // UEX-P1-17：「未处理」不含内容相同自动跳过的（那是已处理的跳过结论，单列 skippedIdentical）
      const skippedCount = total - successCount - failCount - skippedIdenticalCount
      if (batch.canceled) {
        log.info('批量导入已取消', { total, successCount, failCount, skippedCount, skippedIdenticalCount, copiedCount, overwrittenCount })
        return {
          success: true,
          canceled: true,
          results: batchResults,
          total,
          successCount,
          failCount,
          skippedCount,
          skippedIdentical: skippedIdenticalCount,
          copied: copiedCount,
          overwritten: overwrittenCount,
        }
      }
      log.info('批量导入完成', { total, successCount, failCount, skippedIdenticalCount, copiedCount, overwrittenCount })
      return {
        success: true,
        results: batchResults,
        total,
        successCount,
        failCount,
        skippedCount,
        skippedIdentical: skippedIdenticalCount,
        copied: copiedCount,
        overwritten: overwrittenCount,
      }
    } catch (e) {
      log.error('批量导入失败', { error: (e as Error).message })
      return { success: false, error: (e as Error).message }
    } finally {
      // UEX-P2-04：批次结束（含取消/异常）即释放防重入锁，支持取消后立即重新发起
      if (currentImportBatch === batch) currentImportBatch = null
    }
  })

  // 取消批量导入（UEX-P2-04：幂等——重复点击/无进行中批次均安全）
  ipcMain.handle('character:importBatchCancel', () => {
    if (currentImportBatch && !currentImportBatch.canceled) {
      currentImportBatch.canceled = true
      // 中断阶段1封面下载的网络请求；解析中的单个文件允许完成后停下，不强杀同步解析
      currentImportBatch.controller.abort()
      log.info('批量导入取消请求已接收')
    }
  })

  // 重新加载封面
  ipcMain.handle('character:reloadAvatar', async (_event, characterId: string, url: string) => {
    safeId(characterId)
    log.info('重新加载封面', { characterId, url })
    const proxyUrl = getCoverProxyUrl()
    const result = await reloadAvatarFromUrl(characterId, url, proxyUrl)
    if (!result.success) {
      log.warn('封面加载失败', { characterId, error: result.error, code: result.code })
    }
    return result
  })
}
