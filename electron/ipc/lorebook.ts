import type { IpcMain, Dialog } from 'electron'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { nanoid } from 'nanoid'
import { DIRS, writeJson, readJson, listJsonFilesAsync, removeFile, withFileLock } from '../services/storage'
import { createLogger } from '../services/logger'
import type { Lorebook, LoreEntry } from '../../shared/types'
import { getVectorIndex, markStaleEntries } from '../services/vectorStore'
import { safeId } from '../utils/pathGuard'

const log = createLogger('lorebook')

export function registerLorebookIPC(ipcMain: IpcMain, dialog: Dialog): void {
  // 列表
  ipcMain.handle('lorebook:list', async () => {
    return await listJsonFilesAsync<Lorebook>(DIRS.lorebooks())
  })

  // 保存（条目内容变化时自动标记向量索引过期，语义检索会跳过过期条目）
  ipcMain.handle('lorebook:save', async (_e, lorebook: Lorebook) => {
    safeId(lorebook.id)
    const filePath = join(DIRS.lorebooks(), `${lorebook.id}.json`)
    // NEW-M5：读-改-写整体持锁，避免并发保存互相覆盖
    await withFileLock(filePath, () => {
      const prev = existsSync(filePath) ? readJson<Lorebook>(filePath, 'lorebooks') : null
      writeJson(filePath, lorebook)
      // 有向量索引时，对比语义相关字段，标记变化的条目
      if (getVectorIndex(lorebook.id)) {
        const changedIds = diffSemanticEntries(prev?.entries ?? [], lorebook.entries)
        if (changedIds.length > 0) {
          markStaleEntries(lorebook.id, changedIds)
        }
      }
    })
    log.info('世界书已保存', { id: lorebook.id, name: lorebook.name, entries: lorebook.entries.length })
  })

  // 删除
  ipcMain.handle('lorebook:delete', async (_e, id: string) => {
    safeId(id)
    removeFile(join(DIRS.lorebooks(), `${id}.json`))
    log.info('世界书已删除', { id })
  })

  // 导入
  ipcMain.handle('lorebook:importJson', async () => {
    const result = await dialog.showOpenDialog({
      title: '导入世界书',
      filters: [{ name: 'JSON 文件', extensions: ['json'] }],
      properties: ['openFile'],
    })
    if (result.canceled || result.filePaths.length === 0) return null

    const raw = readFileSync(result.filePaths[0], 'utf-8')

    // 格式校验
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error('文件格式错误：不是有效的 JSON 文件')
    }

    // 校验基本结构
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('文件格式错误：JSON 顶层必须是对象')
    }

    // 兼容 SillyTavern 世界书格式
    // NEW-H2 修复：导入文件的 id 必须先通过 safeId 校验（防止路径遍历字符写入任意位置）；
    // 非法时回退为新生成的 nanoid
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = parsed as Record<string, any>
    let importedId: string
    try {
      importedId = p.id ? safeId(p.id) : nanoid()
    } catch {
      importedId = nanoid()
    }
    const lorebook: Lorebook = {
      id: importedId,
      name: p.name ?? '导入的世界书',
      description: p.description ?? '',
      entries: (Array.isArray(p.entries)
        ? p.entries
        : (typeof p.entries === 'object' && p.entries !== null ? Object.values(p.entries) : [])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ).map((e: Record<string, any>, i: number) => {
        // 校验每个条目
        if (!e || typeof e !== 'object') return null
        return {
          id: e.uid?.toString() ?? nanoid(),
          keywords: Array.isArray(e.key) ? e.key.filter((k: unknown): k is string => typeof k === 'string') : (typeof e.key === 'string' ? e.key.split(',').map((s: string) => s.trim()).filter(Boolean) : []),
          content: typeof e.content === 'string' ? e.content : '',
          position: e.position === 0 || e.position === 'before' ? 'before_char'
            : e.position === 1 || e.position === 'after' ? 'after_char'
            : e.position === 2 || e.position === 'depth' || e.position === 'at_depth' ? 'at_depth'
            : 'at_end',
          depth: typeof e.depth === 'number' ? Math.max(0, e.depth) : 0,
          order: typeof e.order === 'number' ? e.order : i,
          probability: typeof e.probability === 'number' ? Math.max(0, Math.min(100, e.probability)) : 100,
          enabled: e.disable ? false : (typeof e.enabled === 'boolean' ? e.enabled : true),
        }
      }).filter(Boolean) as Lorebook['entries'],
      enabled: true,
      scanDepth: typeof p.scan_depth === 'number' ? Math.max(1, p.scan_depth) : 4,
    }

    if (lorebook.entries.length === 0) {
      throw new Error('世界书没有有效的条目')
    }

    writeJson(join(DIRS.lorebooks(), `${lorebook.id}.json`), lorebook, 'lorebooks')
    log.info('世界书已导入', { name: lorebook.name, entries: lorebook.entries.length })
    return lorebook
  })
}

/** 对比新旧条目，找出语义相关字段（内容/启用/匹配模式）变化的条目 id */
function diffSemanticEntries(prev: LoreEntry[], next: LoreEntry[]): string[] {
  const nextMap = new Map(next.map((e) => [e.id, e]))
  const changed = new Set<string>()
  for (const oldEntry of prev) {
    const newEntry = nextMap.get(oldEntry.id)
    if (!newEntry) {
      // 条目被删除：其向量自然失效
      changed.add(oldEntry.id)
      continue
    }
    if (
      oldEntry.content !== newEntry.content ||
      oldEntry.enabled !== newEntry.enabled ||
      (oldEntry.matchMode ?? 'both') !== (newEntry.matchMode ?? 'both')
    ) {
      changed.add(oldEntry.id)
    }
  }
  // 新增条目没有向量，无需标记
  return [...changed]
}
