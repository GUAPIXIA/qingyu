/**
 * 快捷回复存储 IPC
 *
 * 数据文件：data/config/quickReplies.json
 * 结构：{ global: QuickReply[], byCharacter: Record<string, QuickReply[]> }
 * 支持整体保存 + 导入导出（与预设/世界书同款 dialog 交互）。
 */

import type { IpcMain, Dialog } from 'electron'
import { join } from 'node:path'
import { readFileSync, existsSync } from 'node:fs'
import { DIRS, readJson, serializeJson } from '../services/storage'
import { createLogger } from '../services/logger'
import { safeId } from '../utils/pathGuard'
import type { QuickReplyStore, QuickReply } from '../../shared/types'
import { nanoid } from 'nanoid'
import { commitThroughDomain } from '../domain/syncDomainService'
import { writeFileAtomic } from '../domain/pcRepository'

const log = createLogger('quickReply')

const DEFAULT_STORE: QuickReplyStore = { global: [], byCharacter: {} }

/** 整库单实体 ID：与 S2-05 扫描器（quick_reply_set 域）一致 */
const QUICK_REPLY_ROOT_ID = 'quick-replies-root'

function getStorePath(): string {
  return join(DIRS.config(), 'quickReplies.json')
}

function readStore(): QuickReplyStore {
  const store = readJson<QuickReplyStore>(getStorePath())
  if (!store || !Array.isArray(store.global)) return { ...DEFAULT_STORE }
  return { global: store.global, byCharacter: store.byCharacter ?? {} }
}

/** H-9 修复：导出读接口供桥接层复用（此前桥接层误读 quickReplies 目录，数据源不一致恒为空） */
export { readStore }

/** 整库规范 payload：真实内容（替代旧实现的条数骨架 payload） */
function quickReplyStorePayload(store: QuickReplyStore): Record<string, unknown> {
  return {
    global: store.global,
    byCharacter: store.byCharacter,
  }
}

/**
 * 阶段 2 S2-04：quickReplies.json 与其 journal 在同一文件事务内提交。
 * 整库作为 quick-replies-root 单实体保存；磁盘内容未变化时不再重复记账。
 * 角色级集合删除以 qr-char-<characterId> tombstone 记账，避免删除被静默丢失。
 */
function commitQuickReplyStore(store: QuickReplyStore, deletedEntityIds: string[] = []): void {
  const path = getStorePath()
  const content = serializeJson(store)
  const previous = existsSync(path) ? readFileSync(path, 'utf-8') : null
  const puts = previous === content
    ? []
    : [{ entityId: QUICK_REPLY_ROOT_ID, payload: quickReplyStorePayload(store), schemaVersion: 1 }]

  commitThroughDomain({
    domain: 'quick_reply_set',
    entityType: 'quick_reply_set',
    puts,
    deletes: deletedEntityIds.map((entityId) => ({ entityId })),
    files: [{ path, content }],
  })
}

export function registerQuickReplyIPC(ipcMain: IpcMain, dialog: Dialog): void {
  // 读取全部（全局 + 角色级）
  ipcMain.handle('quickReply:listAll', async () => {
    return readStore()
  })

  // 保存（全量写入，保持幂等）
  ipcMain.handle('quickReply:saveAll', async (_e, store: QuickReplyStore) => {
    const clean: QuickReplyStore = {
      global: Array.isArray(store?.global) ? store.global : [],
      byCharacter: store?.byCharacter && typeof store.byCharacter === 'object' ? store.byCharacter : {},
    }
    // 校验字段，防止脏数据
    for (const qr of clean.global) normalizeQuickReply(qr)
    for (const id of Object.keys(clean.byCharacter)) {
      safeId(id)
      // M-15 修复：byCharacter 值未校验数组，脏数据（undefined 等）时 for..of 抛 TypeError 致 saveAll 整体失败
      const list = clean.byCharacter[id]
      if (!Array.isArray(list)) {
        clean.byCharacter[id] = []
        continue
      }
      for (const qr of list) normalizeQuickReply(qr)
    }
    commitQuickReplyStore(clean)
    log.info('快捷回复已保存', {
      global: clean.global.length,
      characters: Object.keys(clean.byCharacter).length,
    })
  })

  // 删除指定角色的专属快捷回复
  ipcMain.handle('quickReply:clearCharacter', async (_e, characterId: string) => {
    safeId(characterId)
    const store = readStore()
    delete store.byCharacter[characterId]
    // 角色级快捷回复集合删除：文件内容随整库实体一并提交，同时为该角色集合落 tombstone
    commitQuickReplyStore(store, [`qr-char-${characterId}`])
  })

  // 导出 JSON（保存对话框）
  ipcMain.handle('quickReply:exportJson', async () => {
    const { dialog: d } = await import('electron')
    const result = await d.showSaveDialog({
      title: '导出快捷回复',
      defaultPath: 'quick-replies.json',
      filters: [{ name: 'JSON 文件', extensions: ['json'] }],
    })
    if (result.canceled || !result.filePath) return { ok: false, canceled: true }
    // 导出目标是用户选择的路径，位于同步域数据目录之外、不属于同步实体：
    // 不写 journal，但仍走统一原子写工具（同目录 tmp + rename），不使用原始写函数。
    writeFileAtomic(result.filePath, JSON.stringify(readStore(), null, 2))
    return { ok: true }
  })

  // 导入 JSON（打开对话框，覆盖合并）
  ipcMain.handle('quickReply:importJson', async () => {
    const result = await dialog.showOpenDialog({
      title: '导入快捷回复',
      filters: [{ name: 'JSON 文件', extensions: ['json'] }],
      properties: ['openFile'],
    })
    if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true }

    try {
      const raw = readFileSync(result.filePaths[0], 'utf-8')
      const parsed = JSON.parse(raw) as QuickReplyStore
      if (!parsed || !Array.isArray(parsed.global)) {
        return { ok: false, error: '文件格式错误：不是有效的快捷回复 JSON' }
      }
      const current = readStore()
      // 合并：导入的全局项替换现有全局；角色项合并（相同角色 id 追加去重）
      const merged: QuickReplyStore = {
        global: parsed.global.map(normalizeQuickReply).filter(Boolean) as QuickReply[],
        byCharacter: { ...current.byCharacter },
      }
      for (const [charId, list] of Object.entries(parsed.byCharacter ?? {})) {
        if (!Array.isArray(list)) continue
        const existing = current.byCharacter[charId] ?? []
        const existingIds = new Set(existing.map((q) => q.id))
        const additions = list
          .map(normalizeQuickReply)
          .filter((q): q is QuickReply => !!q && !existingIds.has(q.id))
        merged.byCharacter[charId] = [...existing, ...additions]
      }
      commitQuickReplyStore(merged)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })
}

/** 规范化快捷回复对象（补 id/缺省字段），非法对象返回 null */
function normalizeQuickReply(qr: QuickReply | null | undefined): QuickReply | null {
  if (!qr || typeof qr !== 'object') return null
  return {
    id: typeof qr.id === 'string' && qr.id ? qr.id : nanoid(),
    label: typeof qr.label === 'string' ? qr.label : '快捷回复',
    content: typeof qr.content === 'string' ? qr.content : '',
    action: qr.action === 'preset' || qr.action === 'command' ? qr.action : 'text',
    presetId: typeof qr.presetId === 'string' ? qr.presetId : undefined,
    command: typeof qr.command === 'string' ? qr.command : undefined,
    sendWithAI: qr.sendWithAI !== false,
    hotkey: typeof qr.hotkey === 'number' && qr.hotkey >= 1 && qr.hotkey <= 9 ? qr.hotkey : undefined,
    order: typeof qr.order === 'number' ? qr.order : 0,
    enabled: qr.enabled !== false,
  }
}

/** 辅助：判断存储文件是否存在（供导出/导入使用，未使用则忽略） */
export function quickReplyStoreExists(): boolean {
  return existsSync(getStorePath())
}
