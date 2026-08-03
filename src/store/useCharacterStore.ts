import { create } from 'zustand'
import type { Character } from '../../shared/types'
import { nanoid } from 'nanoid'
import { migrateLorebookId } from '../utils/lorebook'
import { logError } from '../lib/logger'
import { useSettingsStore } from './useSettingsStore'

/** 导入角色卡后展示前端扩展落地提示（有内容才提示，8s 后自动清除） */
function setImportNotice(cardExtras: { regexCount: number; quickReplyCount: number; skipped?: string[] } | null | undefined): void {
  if (!cardExtras) return
  const parts: string[] = []
  if (cardExtras.regexCount > 0) parts.push(`${cardExtras.regexCount} 条正则脚本`)
  if (cardExtras.quickReplyCount > 0) parts.push(`${cardExtras.quickReplyCount} 条快捷回复`)
  if (parts.length === 0) return
  const skippedNote = cardExtras.skipped && cardExtras.skipped.length > 0
    ? `（跳过 ${cardExtras.skipped.length} 项不支持的功能）`
    : ''
  useCharacterStore.setState({ importNotice: `已导入角色卡前端扩展：${parts.join('、')}${skippedNote}` })
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
  /** 批量导入进度 */
  importProgress: { current: number; total: number; fileName: string; status: 'processing' | 'done' | 'error' } | null
  loadCharacters: () => Promise<void>
  selectCharacter: (id: string | null) => void
  createCharacter: () => Character
  saveCharacter: (character: Character) => Promise<void>
  /** 局部更新角色字段，不修改 updatedAt，不重新排序 */
  patchCharacter: (id: string, patch: Partial<Character>) => Promise<void>
  togglePin: (id: string) => Promise<void>
  deleteCharacter: (id: string) => Promise<void>
  importPng: () => Promise<Character | null>
  importJson: () => Promise<Character | null>
  importBatch: () => Promise<{
    success: boolean
    results?: { name: string; success: boolean; error?: string; needAvatar?: boolean }[]
    total?: number
    successCount?: number
    failCount?: number
  } | null>
  exportPng: (id: string) => Promise<void>
  exportJson: (id: string) => Promise<void>
}

export const useCharacterStore = create<CharacterState>((set, get) => ({
  characters: [],
  currentCharacter: null,
  loaded: false,
  importError: null,
  importNotice: null,
  pendingAvatarId: null,
  importProgress: null,

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

  importPng: async () => {
    const unbind = window.api.character.onImportProgress((data) => {
      set({ importProgress: data })
    })
    try {
      const result = await window.api.character.importPng()
      if (result.canceled) { set({ importProgress: null }); return null }
      if (result.success && result.character) {
        await get().loadCharacters()
        setImportNotice(result.cardExtras)
        setTimeout(() => set({ importProgress: null }), 1500)
        return result.character
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

  importJson: async () => {
    const unbind = window.api.character.onImportProgress((data) => {
      set({ importProgress: data })
    })
    try {
      const result = await window.api.character.importJson()
      if (result.canceled) { set({ importProgress: null }); return null }
      if (result.success && result.character) {
        await get().loadCharacters()
        setImportNotice(result.cardExtras)
        if (result.needAvatar) {
          set({ pendingAvatarId: result.character.id })
        }
        setTimeout(() => set({ importProgress: null }), 1500)
        return result.character
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

  importBatch: async () => {
    // 注册进度监听
    const unbind = window.api.character.onImportProgress((data) => {
      set({ importProgress: data })
    })
    try {
      const result = await window.api.character.importBatch()
      if (result.canceled) { set({ importProgress: null }); return null }
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
      // 完成后清除进度（延迟一点以便用户看到 100%）
      setTimeout(() => set({ importProgress: null }), 1500)
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
    }
  },

  exportPng: async (id) => {
    await window.api.character.exportPng(id)
  },

  exportJson: async (id) => {
    await window.api.character.exportJson(id)
  },
}))