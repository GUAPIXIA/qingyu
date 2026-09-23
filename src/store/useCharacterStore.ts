import { create } from 'zustand'
import type { Character } from '../../shared/types'
import { nanoid } from 'nanoid'
import { migrateLorebookId } from '../utils/lorebook'
import { logError } from '../lib/logger'
import { useSettingsStore } from './useSettingsStore'
import { useToastStore } from './useToastStore'
// UEX-P1-17：导入查重/冲突策略与处理结果类型
import type { CharacterImportConflictPolicy, CharacterImportOutcome } from '../../shared/ipc-api'

/** 导入角色卡后展示前端扩展落地提示（有内容才提示，8s 后自动清除）；UEX-P1-17：可附带查重/冲突明细 */
function setImportNotice(cardExtras: { regexCount: number; quickReplyCount: number; skipped?: string[] } | null | undefined, importNote?: string): void {
  const parts: string[] = []
  if (cardExtras) {
    if (cardExtras.regexCount > 0) parts.push(`${cardExtras.regexCount} 条正则脚本`)
    if (cardExtras.quickReplyCount > 0) parts.push(`${cardExtras.quickReplyCount} 条快捷回复`)
  }
  const segments: string[] = []
  // UEX-P1-17：查重/冲突结论（「已存在相同角色：{name}」/「已另存副本：…」/「已覆盖同名角色：…」）
  if (importNote) segments.push(importNote)
  if (parts.length > 0) {
    const skippedNote = cardExtras?.skipped && cardExtras.skipped.length > 0
      ? `（跳过 ${cardExtras.skipped.length} 项不支持的功能）`
      : ''
    segments.push(`已导入角色卡前端扩展：${parts.join('、')}${skippedNote}`)
  }
  if (segments.length === 0) return
  useCharacterStore.setState({ importNotice: segments.join('；') })
  setTimeout(() => useCharacterStore.setState({ importNotice: null }), 8000)
}

/** 创建示例角色 */
function createSampleCharacter(): Character {
  const now = Date.now()
  return {
    id: nanoid(),
    name: '艾莉娅',
    avatar: '',
    description: '一位来自星界的旅行法师，拥有银色长发和紫色的眼眸。性格好奇而活泼，对人间的一切充满兴趣。虽然有时会犯些小迷糊，但在关键时刻总能展现出惊人的魔力天赋。',
    personality: '好奇、活泼、偶尔迷糊、善良、勇敢',
    scenario: '你在一次冒险中遇到了艾莉娅，她正在研究一本古老的魔法书。',
    firstMessage: '*一阵光芒闪过，一位银发少女从传送门中走出，差点撞到你*\n\n"哎呀！对不起对不起！我又算错坐标了..."\n\n*她拍了拍身上的灰尘，好奇地看着你*\n\n"你好呀！我叫艾莉娅，是来自星界的旅行法师。你...不会是这个世界的原住民吧？太好了！我可以问你一些关于这个世界的事情吗？"',
    exampleDialog: '{{user}}: 你好，你是谁？\n{{char}}: *微微行礼* 我是艾莉娅，一位星界旅行法师。正在研究各个世界的魔法文化呢！你呢？',
    tags: ['奇幻', '法师', '女性', '冒险'],
    lorebookId: null,
    alternateGreetings: [],
    creator: '轻语',
    createdAt: now,
    updatedAt: now,
  }
}

interface CharacterState {
  characters: Character[]
  currentCharacter: Character | null
  loaded: boolean
  importError: string | null
  /** 导入角色卡时前端扩展（正则/快捷回复）落地的提示 */
  importNotice: string | null
  pendingAvatarId: string | null
  /** 导入后检测到的候选世界书（待用户确认绑定） */
  lorebookSuggestions: import('../../shared/ipc-api').LorebookSuggestion[] | null
  /** 待绑定世界书的角色 ID */
  pendingLorebookCharacterId: string | null
  /** 批量导入进度 */
  importProgress: { current: number; total: number; fileName: string; status: 'processing' | 'done' | 'error' } | null
  /** UEX-P2-04：批量导入是否进行中（UI 据此禁用导入入口并显示「取消导入」按钮） */
  importingBatch: boolean
  loadCharacters: () => Promise<void>
  selectCharacter: (id: string | null) => void
  createCharacter: () => Character
  saveCharacter: (character: Character) => Promise<void>
  /** 局部更新角色字段，不修改 updatedAt，不重新排序 */
  patchCharacter: (id: string, patch: Partial<Character>) => Promise<void>
  togglePin: (id: string) => Promise<void>
  deleteCharacter: (id: string) => Promise<void>
  /** UEX-P1-17：conflict 为同名冲突策略（默认另存副本；相同卡始终跳过） */
  importPng: (conflict?: CharacterImportConflictPolicy) => Promise<Character | null>
  /** UEX-P1-17：conflict 为同名冲突策略（默认另存副本；相同卡始终跳过） */
  importJson: (conflict?: CharacterImportConflictPolicy) => Promise<Character | null>
  /** UEX-P1-17：conflict 为同名冲突策略（默认另存副本；批内重复同策略去重） */
  importBatch: (conflict?: CharacterImportConflictPolicy) => Promise<{
    success: boolean
    results?: { name: string; success: boolean; error?: string; needAvatar?: boolean; outcome?: CharacterImportOutcome; note?: string }[]
    total?: number
    successCount?: number
    failCount?: number
    /** UEX-P2-04：导入中被取消（success:true，已完成明细保留在 results） */
    canceled?: boolean
    /** UEX-P2-04：取消时未处理的文件数 */
    skippedCount?: number
    /** UEX-P1-17：内容相同自动跳过的数量 */
    skippedIdentical?: number
    /** UEX-P1-17：同名冲突另存副本的数量 */
    copied?: number
    /** UEX-P1-17：显式覆盖同名原卡的数量 */
    overwritten?: number
  } | null>
  /** UEX-P2-04：取消进行中的批量导入（幂等：重复调用/无进行中批次均安全） */
  cancelImportBatch: () => Promise<void>
  exportPng: (id: string) => Promise<import('../../shared/ipc-api').CharacterExportResult>
  exportJson: (id: string) => Promise<import('../../shared/ipc-api').CharacterExportResult>
  exportCover: (id: string) => Promise<void>
  /** 绑定/忽略导入时推荐的世界书（null = 忽略） */
  bindSuggestedLorebook: (lorebookId: string | null) => Promise<void>
}

export const useCharacterStore = create<CharacterState>((set, get) => ({
  characters: [],
  currentCharacter: null,
  loaded: false,
  importError: null,
  importNotice: null,
  pendingAvatarId: null,
  importProgress: null,
  importingBatch: false,
  lorebookSuggestions: null,
  pendingLorebookCharacterId: null,

  loadCharacters: async () => {
    let characters = await window.api.character.list()

    // 首次使用：如果没有角色，自动创建示例角色
    if (characters.length === 0) {
      const sample = createSampleCharacter()
      await window.api.character.save(sample)
      characters = await window.api.character.list()
    }

    // 迁移 legacy lorebookId 到 boundLorebookIds（后台静默保存）
    let migrated = false
    for (let i = 0; i < characters.length; i++) {
      const c = characters[i]
      if (c && c.lorebookId && (!c.boundLorebookIds || c.boundLorebookIds.length === 0)) {
        characters[i] = migrateLorebookId(c)
        migrated = true
      }
    }
    if (migrated) {
      for (const c of characters) {
        if (c.boundLorebookIds?.length === 1) {
          window.api.character.save(c).catch((e) => logError('CharacterStore:save', e))
        }
      }
    }

    // 置顶角色排在前面
    characters.sort((a, b) => {
      if (a.pinned && !b.pinned) return -1
      if (!a.pinned && b.pinned) return 1
      return b.updatedAt - a.updatedAt
    })

    set({ characters, loaded: true })

    // 恢复上次选择的角色
    const settings = await window.api.settings.get()
    if (settings.activeCharacterId) {
      const char = characters.find((c) => c.id === settings.activeCharacterId)
      if (char) set({ currentCharacter: char })
    }
  },

  selectCharacter: (id) => {
    if (!id) {
      set({ currentCharacter: null })
      return
    }
    const char = get().characters.find((c) => c.id === id) ?? null
    set({ currentCharacter: char })
    // 同步更新内存中的 settings 并立即持久化到磁盘
    // 修复：必须同时更新内存，否则后续 debounced updateSettings 会用旧 activeCharacterId 覆盖磁盘
    const settingsStore = useSettingsStore.getState()
    settingsStore.updateSettings({ activeCharacterId: id })
    settingsStore.flushSettings()
  },

  createCharacter: () => {
    const now = Date.now()
    const character: Character = {
      id: nanoid(),
      name: '新角色',
      avatar: '',
      description: '',
      personality: '',
      scenario: '',
      firstMessage: '',
      exampleDialog: '',
      tags: [],
      lorebookId: null,
      alternateGreetings: [],
      creator: '',
      createdAt: now,
      updatedAt: now,
    }
    return character
  },

  saveCharacter: async (character) => {
    // 自动迁移：如果只有 legacy lorebookId 而没有 boundLorebookIds，则转换
    character = migrateLorebookId(character)
    character.updatedAt = Date.now()
    await window.api.character.save(character)
    set((state) => {
      const idx = state.characters.findIndex((c) => c.id === character.id)
      const chars = [...state.characters]
      if (idx >= 0) chars[idx] = character
      else chars.push(character)
      // 重新排序：置顶在前
      chars.sort((a, b) => {
        if (a.pinned && !b.pinned) return -1
        if (!a.pinned && b.pinned) return 1
        return b.updatedAt - a.updatedAt
      })
      return {
        characters: chars,
        currentCharacter: state.currentCharacter?.id === character.id ? character : state.currentCharacter,
      }
    })
  },

  /** 局部更新角色字段，不修改 updatedAt，不重新排序 */
  patchCharacter: async (id, patch) => {
    const char = get().characters.find((c) => c.id === id)
    if (!char) return
    const updated = { ...char, ...patch }
    await window.api.character.save(updated)
    set((state) => {
      const idx = state.characters.findIndex((c) => c.id === id)
      if (idx < 0) return {}
      const chars = [...state.characters]
      chars[idx] = updated
      return {
        characters: chars,
        currentCharacter: state.currentCharacter?.id === id ? updated : state.currentCharacter,
      }
    })
  },

  togglePin: async (id) => {
    const char = get().characters.find((c) => c.id === id)
    if (!char) return
    const updated = { ...char, pinned: !char.pinned, updatedAt: Date.now() }
    await window.api.character.save(updated)
    set((state) => {
      const chars = state.characters.map((c) => (c.id === id ? updated : c))
      // 重新排序
      chars.sort((a, b) => {
        if (a.pinned && !b.pinned) return -1
        if (!a.pinned && b.pinned) return 1
        return b.updatedAt - a.updatedAt
      })
      return {
        characters: chars,
        currentCharacter: state.currentCharacter?.id === id ? updated : state.currentCharacter,
      }
    })
  },

  deleteCharacter: async (id) => {
    await window.api.character.delete(id)
    set((state) => ({
      characters: state.characters.filter((c) => c.id !== id),
      currentCharacter: state.currentCharacter?.id === id ? null : state.currentCharacter,
    }))
  },

  importPng: async (conflict) => {
    const unbind = window.api.character.onImportProgress((data) => {
      set({ importProgress: data })
    })
    try {
      const result = await window.api.character.importPng(conflict)
      if (result.canceled) { set({ importProgress: null }); return null }
      if (result.success && result.character) {
        await get().loadCharacters()
        // UEX-P1-17：副本/覆盖结论随前端扩展提示一并展示（正常导入不额外提示）
        setImportNotice(result.cardExtras, result.outcome !== 'imported' ? result.note : undefined)
        // 世界书推荐（显式确认）：导入后弹出候选供用户选择绑定
        if (result.lorebookSuggestions && result.lorebookSuggestions.length > 0) {
          set({
            lorebookSuggestions: result.lorebookSuggestions,
            pendingLorebookCharacterId: result.character.id,
          })
        }
        setTimeout(() => set({ importProgress: null }), 1500)
        return result.character
      }
      // UEX-P1-17：内容相同自动跳过（不产生新卡），提示「已存在相同角色：{name}」
      if (result.success && result.outcome === 'skippedIdentical') {
        setImportNotice(undefined, result.note)
        setTimeout(() => set({ importProgress: null }), 1500)
        return null
      }
      if (result.error) {
        set({ importProgress: null, importError: result.error })
        setTimeout(() => set({ importError: null }), 5000)
      }
      return null
    } finally {
      setTimeout(() => { unbind(); set({ importProgress: null }) }, 2000)
    }
  },

  importJson: async (conflict) => {
    const unbind = window.api.character.onImportProgress((data) => {
      set({ importProgress: data })
    })
    try {
      const result = await window.api.character.importJson(conflict)
      if (result.canceled) { set({ importProgress: null }); return null }
      if (result.success && result.character) {
        await get().loadCharacters()
        // UEX-P1-17：副本/覆盖结论随前端扩展提示一并展示（正常导入不额外提示）
        setImportNotice(result.cardExtras, result.outcome !== 'imported' ? result.note : undefined)
        // 世界书推荐（显式确认）：导入后弹出候选供用户选择绑定
        if (result.lorebookSuggestions && result.lorebookSuggestions.length > 0) {
          set({
            lorebookSuggestions: result.lorebookSuggestions,
            pendingLorebookCharacterId: result.character.id,
          })
        }
        if (result.needAvatar) {
          set({ pendingAvatarId: result.character.id })
        }
        setTimeout(() => set({ importProgress: null }), 1500)
        return result.character
      }
      // UEX-P1-17：内容相同自动跳过（不产生新卡），提示「已存在相同角色：{name}」
      if (result.success && result.outcome === 'skippedIdentical') {
        setImportNotice(undefined, result.note)
        setTimeout(() => set({ importProgress: null }), 1500)
        return null
      }
      if (result.error) {
        set({ importProgress: null, importError: result.error })
        setTimeout(() => set({ importError: null }), 5000)
      }
      return null
    } finally {
      setTimeout(() => { unbind(); set({ importProgress: null }) }, 2000)
    }
  },

  importBatch: async (conflict) => {
    // UEX-P2-04：防重入——已有批量导入进行中时不再发起（主进程另有「已有导入任务进行中」兜底）
    if (get().importingBatch) return null
    set({ importingBatch: true })
    // 注册进度监听
    const unbind = window.api.character.onImportProgress((data) => {
      set({ importProgress: data })
    })
    try {
      // UEX-P1-17：conflict 透传给主进程（默认另存副本，'overwrite' 仅用户显式选择）
      const result = await window.api.character.importBatch(conflict)
      // UEX-P2-04：区分「选文件对话框取消」（无明细，静默返回）与「导入中取消」（保留已完成明细供结果条展示）
      if (result.canceled && !result.success) { set({ importProgress: null }); return null }
      if (!result.success) {
        if (result.error) {
          set({ importError: result.error, importProgress: null })
          setTimeout(() => set({ importError: null }), 5000)
        } else {
          set({ importProgress: null })
        }
        return null
      }
      await get().loadCharacters()
      if (result.canceled) {
        // UEX-P2-04：已取消立即收起进度条（取消汇总由页面结果条展示，不自动消失）
        set({ importProgress: null })
      } else {
        // 完成后清除进度（延迟一点以便用户看到 100%）
        setTimeout(() => set({ importProgress: null }), 1500)
      }
      // 如果有需要头像的角色，标记第一个
      const needAvatarItem = result.results?.find(r => r.success && r.needAvatar)
      if (needAvatarItem) {
        const chars = get().characters
        const matched = chars.find(c => c.name === needAvatarItem.name)
        if (matched) {
          set({ pendingAvatarId: matched.id })
        }
      }
      return result
    } finally {
      unbind()
      // UEX-P2-04：批次结束即解除防重入（取消后可立即重新发起）
      set({ importingBatch: false })
    }
  },

  // UEX-P2-04：取消进行中的批量导入（主进程幂等：重复调用/无批次均安全）
  cancelImportBatch: async () => {
    await window.api.character.importBatchCancel()
  },

  // UEX-P1-18：导出结果回传并提示（此前 fire-and-forget 全静默）
  exportPng: async (id) => {
    try {
      const result = await window.api.character.exportPng(id)
      if (result && result.ok) {
        useToastStore.getState().push({ variant: 'success', title: `已导出：${result.path ?? ''}`, requestId: 'char-export' })
      } else if (result && !result.canceled) {
        useToastStore.getState().push({ variant: 'error', title: `导出失败：${result.error || '未知错误'}`, requestId: 'char-export' })
      }
      return result ?? { ok: false }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      useToastStore.getState().push({ variant: 'error', title: `导出失败：${error}`, requestId: 'char-export' })
      return { ok: false, error }
    }
  },

  // UEX-P1-18：导出结果回传并提示（此前 fire-and-forget 全静默）
  exportJson: async (id) => {
    try {
      const result = await window.api.character.exportJson(id)
      if (result && result.ok) {
        useToastStore.getState().push({ variant: 'success', title: `已导出：${result.path ?? ''}`, requestId: 'char-export' })
      } else if (result && !result.canceled) {
        useToastStore.getState().push({ variant: 'error', title: `导出失败：${result.error || '未知错误'}`, requestId: 'char-export' })
      }
      return result ?? { ok: false }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      useToastStore.getState().push({ variant: 'error', title: `导出失败：${error}`, requestId: 'char-export' })
      return { ok: false, error }
    }
  },

  exportCover: async (id) => {
    const result = await window.api.character.exportCover(id)
    if (result && !result.ok && !result.canceled) {
      set({ importError: result.error || '封面导出失败' })
      setTimeout(() => set({ importError: null }), 5000)
    }
  },

  bindSuggestedLorebook: async (lorebookId) => {
    const characterId = get().pendingLorebookCharacterId
    // 先清状态（无论绑定或忽略）
    set({ lorebookSuggestions: null, pendingLorebookCharacterId: null })
    if (!characterId || lorebookId === null) return
    try {
      await window.api.character.bindLorebook(characterId, lorebookId)
      await get().loadCharacters()
    } catch (e) {
      logError('CharacterStore:bindLorebook', e)
      set({ importError: e instanceof Error ? e.message : '绑定世界书失败' })
      setTimeout(() => set({ importError: null }), 5000)
    }
  },
}))