/**
 * useCharacterStore 单元测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useCharacterStore } from '../useCharacterStore'
import type { Character } from '../../../shared/types'

const mockList = vi.fn<() => Promise<Character[]>>(async () => [])
const mockSave = vi.fn(async () => {})
const mockDelete = vi.fn(async () => {})
const mockGet = vi.fn(async () => null)

function makeCharacter(overrides: Partial<Character> = {}): Character {
  return {
    id: 'c1', name: '角色1', avatar: '', description: '', personality: '', scenario: '',
    firstMessage: '', exampleDialog: '', tags: [], lorebookId: null, alternateGreetings: [],
    creator: '', createdAt: 0, updatedAt: 0,
    ...overrides,
  }
}

Object.defineProperty(window, 'api', {
  value: {
    character: {
      list: mockList,
      save: mockSave,
      delete: mockDelete,
      get: mockGet,
    },
    settings: {
      get: vi.fn(async () => ({ activeCharacterId: null })),
      save: vi.fn(async () => {}),
    },
  },
})

describe('useCharacterStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockList.mockResolvedValue([])
    // 重置 store 状态
    useCharacterStore.setState({
      characters: [],
      currentCharacter: null,
      loaded: false,
    })
  })

  describe('loadCharacters', () => {
    it('加载角色列表', async () => {
      const mockChars = [
        makeCharacter({ id: 'c1', name: '角色1', updatedAt: 100 }),
        makeCharacter({ id: 'c2', name: '角色2', updatedAt: 200 }),
      ]
      mockList.mockResolvedValue(mockChars)

      await useCharacterStore.getState().loadCharacters()

      const state = useCharacterStore.getState()
      expect(state.characters).toHaveLength(2)
      expect(state.loaded).toBe(true)
    })

    it('空列表时自动创建示例角色', async () => {
      mockList.mockResolvedValueOnce([])
      mockList.mockResolvedValueOnce([makeCharacter({ id: 'sample', name: '艾莉娅' })])

      await useCharacterStore.getState().loadCharacters()

      expect(mockSave).toHaveBeenCalled()
    })
  })

  describe('selectCharacter', () => {
    it('选中角色', () => {
      useCharacterStore.setState({
        characters: [{ id: 'c1', name: '角色1' } as any],
      })

      useCharacterStore.getState().selectCharacter('c1')

      expect(useCharacterStore.getState().currentCharacter?.id).toBe('c1')
    })

    it('传 null 取消选中', () => {
      useCharacterStore.setState({
        currentCharacter: { id: 'c1', name: '角色1' } as any,
      })

      useCharacterStore.getState().selectCharacter(null)

      expect(useCharacterStore.getState().currentCharacter).toBeNull()
    })
  })

  describe('deleteCharacter', () => {
    it('删除角色后刷新列表', async () => {
      mockList.mockResolvedValue([makeCharacter({ id: 'c1', name: '角色1' })])
      await useCharacterStore.getState().loadCharacters()

      mockList.mockResolvedValue([])
      await useCharacterStore.getState().deleteCharacter('c1')

      expect(mockDelete).toHaveBeenCalledWith('c1')
    })
  })
})
