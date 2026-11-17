import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { getDefaultSettings } from '../../../../shared/defaults'
import type { Character } from '../../../../shared/types'
import { useSettingsStore } from '../../../store/useSettingsStore'
import { useCharacterStore } from '../../../store/useCharacterStore'
import { formatRelativeTime } from '../../../utils/format'
import { CharacterCard } from '../CharacterCard'

const character: Character = {
  id: 'char-1', name: 'Alice', avatar: '', description: '', personality: '',
  scenario: '', firstMessage: '', exampleDialog: '', tags: [], lorebookId: null,
  creator: '', createdAt: 0, updatedAt: 0, alternateGreetings: [],
}

describe('CharacterCard', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      settings: getDefaultSettings(),
      credentials: {},
      loaded: true,
      _saveTimer: null,
    })
  })

  it('开始对话使用纯图标按钮，同时保留无障碍名称和点击行为', () => {
    const onChat = vi.fn()
    render(
      <CharacterCard
        character={character}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onChat={onChat}
      />,
    )

    const chatButton = screen.getByRole('button', { name: '开始对话' })
    expect(chatButton.textContent).toBe('')
    fireEvent.click(chatButton)
    expect(onChat).toHaveBeenCalledWith(character)
  })

  it('更多菜单可导出封面图片，调用 exportCover', async () => {
    const exportCover = vi.fn()
    useCharacterStore.setState({ exportCover })

    render(
      <CharacterCard
        character={character}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onChat={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '更多操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /导出/ }))
    // UEX-P1-18：导出改为 await + 进行中态，act 内冲刷微任务避免 act 警告
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '封面图片' }))
    })

    expect(exportCover).toHaveBeenCalledWith(character.id)
  })

  describe('卡片尺寸档', () => {
    const tagged: Character = {
      ...character,
      tags: ['Netori', 'NTR', 'R-18', 'Drama'],
      updatedAt: Date.now() - 30 * 24 * 60 * 60 * 1000,
    }

    it('小卡片：多显示标签（2 个 + 计数），且不再显示更新时间', () => {
      const { container } = render(
        <CharacterCard
          character={tagged}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
          onChat={vi.fn()}
          cardSize="sm"
        />,
      )
      const card = container.querySelector('.card') as HTMLElement
      expect(card.textContent).toContain('Netori')
      expect(card.textContent).toContain('NTR')
      expect(card.textContent).not.toContain('R-18')
      expect(card.textContent).toContain('+2')
      expect(card.textContent).toContain('+3')
      expect(card.textContent).not.toContain(formatRelativeTime(tagged.updatedAt))
      expect(card.className).toContain('card-sm')
      // 单行不换行 + 首个标签保宽 + 其余标签截断
      const tag = Array.from(card.querySelectorAll('span')).find((s) => s.textContent === 'Netori')!
      expect(tag.className).toContain('shrink-0')
      expect(tag.className).toContain('truncate')
      expect(tag.parentElement!.className).toContain('flex-nowrap')
    })

    it('小卡片：性格碎片计数不与标签计数并排出现（Kiku 场景）', () => {
      const kiku: Character = {
        ...character,
        name: 'Kiku',
        tags: ['Non-Con', 'Romantic', 'sweet', 'NSFW', 'Bully Victim', 'Female', 'Cute'],
        personality: 'a,b,c,d,e,f,g,h,i,j,k,l,m',
      }
      const { container } = render(
        <CharacterCard
          character={kiku}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
          onChat={vi.fn()}
          cardSize="sm"
        />,
      )
      const card = container.querySelector('.card') as HTMLElement
      // 性格碎片 13 段全部隐藏，不应出现「+13」
      expect(card.textContent).not.toContain('+13')
      // 只保留标签计数（DOM 同时渲染两套文案，由容器查询按宽度显示其一：宽卡 +5 / 窄卡 +6）
      expect(card.textContent).toContain('+5')
      expect(card.textContent).toContain('+6')
    })

    it('中卡片：仍显示更新时间，只多出标签 +1', () => {
      const { container } = render(
        <CharacterCard
          character={tagged}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
          onChat={vi.fn()}
          cardSize="md"
        />,
      )
      const card = container.querySelector('.card') as HTMLElement
      expect(card.textContent).toContain('+1')
      expect(card.textContent).toContain(formatRelativeTime(tagged.updatedAt))
      const tag = Array.from(card.querySelectorAll('span')).find((s) => s.textContent === 'Netori')!
      expect(tag.parentElement!.className).toContain('flex-wrap')
    })
  })
})
