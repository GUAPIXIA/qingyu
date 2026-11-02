import { describe, expect, it } from 'vitest'
import type { Character } from '../../../shared/types'
import { useCharacterStore } from '../useCharacterStore'
import { hasGroupGreeting, resolveGroupGreetingOptions } from '../../features/group-chat/groupGreetings'

function makeCharacter(patch: Partial<Character>): Character {
  return { ...useCharacterStore.getState().createCharacter(), id: 'c1', name: 'Aiko', ...patch }
}

describe('resolveGroupGreetingOptions（群聊开场白来源）', () => {
  it('群聊专属开场白优先，非空时不再拼单聊开场白', () => {
    const character = makeCharacter({
      firstMessage: '首条',
      alternateGreetings: ['备选'],
      groupOnlyGreetings: ['群聊专属一', '群聊专属二'],
    })
    expect(resolveGroupGreetingOptions(character)).toEqual(['群聊专属一', '群聊专属二'])
  })

  it('无群聊专属开场白时回退首条消息 + 备选开场白（与单聊对齐）', () => {
    const character = makeCharacter({ firstMessage: '首条', alternateGreetings: ['备选一', '备选二'] })
    expect(resolveGroupGreetingOptions(character)).toEqual(['首条', '备选一', '备选二'])
  })

  it('备选开场白优先用译文', () => {
    const character = makeCharacter({
      firstMessage: 'EN first',
      alternateGreetings: ['EN alt'],
      translatedContent: { firstMessage: '译文首条', alternateGreetings: ['译文备选'] },
    })
    expect(resolveGroupGreetingOptions(character)).toEqual(['译文首条', '译文备选'])
  })

  it('只有备选开场白（首条为空）时仍可用；空字符串被过滤', () => {
    const character = makeCharacter({ firstMessage: '', alternateGreetings: ['只有备选', '  '] })
    expect(resolveGroupGreetingOptions(character)).toEqual(['只有备选'])
    expect(hasGroupGreeting(character)).toBe(true)
    expect(hasGroupGreeting(makeCharacter({ firstMessage: '', alternateGreetings: [] }))).toBe(false)
    expect(hasGroupGreeting(undefined)).toBe(false)
  })
})
