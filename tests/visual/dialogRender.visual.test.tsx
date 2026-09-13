/**
 * PC 视觉/几何回归（jsdom 可完成的部分）：
 * - 无横向溢出语义（结构完整）
 * - 流式闭合前后 block 类型不变
 * - 连续对白间距 class 存在
 * - XSS 无 script
 * - 单聊/群聊相同 class
 */
import React from 'react'
import { describe, expect, it, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { RoleplayContentRenderer } from '../../src/components/chat/RoleplayContentRenderer'
import { MessageBubble } from '../../src/components/chat/MessageBubble'
import { GroupChatMessage } from '../../src/components/chat/GroupChatMessage'
import { useSettingsStore } from '../../src/store/useSettingsStore'
import { useCharacterStore } from '../../src/store/useCharacterStore'
import { parseRoleplayBlocks } from '../../src/utils/roleplayBlocks'
import type { Character, GroupMessage, Message } from '../../shared/types'

function char(): Character {
  return {
    id: 'c1',
    name: '苏晚',
    description: '',
    personality: '',
    scenario: '',
    firstMessage: '',
    exampleDialog: '',
    tags: [],
    creator: '',
    createdAt: 0,
    updatedAt: 0,
    alternateGreetings: [],
    avatar: '',
  } as Character
}

function msg(content: string, mode: 'blocks' | 'markdown' = 'blocks'): Message {
  return {
    id: 'm1',
    sessionId: 's1',
    characterId: 'c1',
    role: 'assistant',
    content,
    images: [],
    isEditing: false,
    timestamp: 0,
    contentRenderMode: mode,
  } as Message
}

function gmsg(content: string, mode: 'blocks' | 'markdown' = 'blocks'): GroupMessage {
  return {
    id: 'g1',
    groupId: 'g1',
    characterId: 'c1',
    content,
    images: [],
    timestamp: 0,
    round: 1,
    contentRenderMode: mode,
  } as GroupMessage
}

const FIXTURES = {
  standard: '苏晚：“我回来了。”\n\n她把湿伞靠在门边，没有看你。',
  quotes: '苏晚：“弯引号。”\n苏晚：「直角引号。」\n苏晚：『双直角。』\n苏晚:"ASCII。"',
  longDialogue: '苏晚：“我不知道该从哪一句说起。雨下了整夜，巷口的路灯一盏一盏灭掉，像有人沿着街把开关一个个按下。我数到第七盏的时候，你敲了门。”',
  longNarration: '她站在窗前没有开灯。玻璃上映出半张脸，以及窗外被雨打散的霓虹。桌上的茶凉了，杯沿留着一圈浅褐色的印子。远处有夜班公交报站的声音，闷闷的，像从水底传来。',
  inlineMd: '这是**粗体**与 `code()` 与 [链接](https://example.com) 的混排。',
  thought: '<thought>他浑身是水，先别问为什么来。</thought>\n\n苏晚没有回头。',
  streamPartial: '苏晚：“我回来了',
  streamClosed: '苏晚：“我回来了。”',
  legacy: '苏晚：“我知道。”\n紫色外星人再次回击，交叉双臂。\n尤诺娃：“选我！”',
  opener: '（她把湿伞靠在门边，没有看你）“……你淋透了。”\n\n- A\n- B',
  xss: '<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>',
}

describe('PC 视觉夹具（几何/结构）', () => {
  beforeEach(() => {
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, userName: '你' } }))
    useCharacterStore.setState({ characters: [char()] })
  })

  it('四类引号均产生 dialogue-block', () => {
    const { container } = render(
      <RoleplayContentRenderer content={FIXTURES.quotes} contentRenderMode="blocks" />,
    )
    const kinds = [...container.querySelectorAll('[data-block-kind]')].map((el) =>
      el.getAttribute('data-block-kind'),
    )
    expect(kinds.filter((k) => k === 'dialogue').length).toBe(4)
  })

  it('长对白/长旁白均有内容且结构完整', () => {
    const long = render(
      <RoleplayContentRenderer content={FIXTURES.longDialogue} contentRenderMode="blocks" />,
    )
    expect(long.container.textContent).toContain('雨下了整夜')
    const narr = render(
      <RoleplayContentRenderer content={FIXTURES.longNarration} contentRenderMode="blocks" />,
    )
    expect(narr.container.textContent).toContain('玻璃上映出半张脸')
    // 无横向溢出标记：根容器应有 min-width 保护（break-words / pre-wrap）
    expect(long.container.querySelector('.whitespace-pre-wrap, .dialogue-block')).toBeTruthy()
  })

  it('流式闭合前后 block 类型不变，闭合后去掉 is-incomplete', () => {
    const partial = parseRoleplayBlocks(FIXTURES.streamPartial, { phase: 'streaming' })
    const closed = parseRoleplayBlocks(FIXTURES.streamClosed, { phase: 'streaming' })
    expect(partial[0]?.kind).toBe('dialogue')
    expect(closed[0]?.kind).toBe('dialogue')
    expect(partial[0]).toMatchObject({ complete: false })
    expect(closed[0]).not.toMatchObject({ complete: false })

    const p = render(
      <RoleplayContentRenderer content={FIXTURES.streamPartial} contentRenderMode="blocks" isStreaming />,
    )
    expect(p.container.querySelector('.is-incomplete')).toBeTruthy()
    p.unmount()
    const c = render(
      <RoleplayContentRenderer content={FIXTURES.streamClosed} contentRenderMode="blocks" isStreaming />,
    )
    expect(c.container.querySelector('.is-incomplete')).toBeNull()
    expect(c.container.querySelector('.dialogue-block')).toBeTruthy()
  })

  it('连续对白使用相邻收紧 class 结构（p.dialogue-block 连续）', () => {
    const { container } = render(
      <RoleplayContentRenderer
        content={'“第一句。”\n苏晚：“第二句。”'}
        contentRenderMode="blocks"
      />,
    )
    const blocks = container.querySelectorAll('.dialogue-block')
    expect(blocks.length).toBe(2)
  })

  it('历史 Markdown 连续对白仍可读且不产生 script', () => {
    const { container } = render(
      <RoleplayContentRenderer content={FIXTURES.legacy} contentRenderMode="markdown" />,
    )
    expect(container.textContent).toContain('我知道')
    expect(container.textContent).toContain('紫色外星人')
    expect(container.querySelector('script')).toBeNull()
  })

  it('开场白走 markdown 模式，列表/引号正文保留', () => {
    const { container } = render(<MessageBubble message={msg(FIXTURES.opener, 'markdown')} character={char()} isLast={false} />)
    expect(container.textContent).toContain('淋透了')
    expect(container.querySelector('ul, li, p')).toBeTruthy()
  })

  it('XSS：script/onerror 不生成可执行节点', () => {
    const { container } = render(
      <RoleplayContentRenderer content={FIXTURES.xss} contentRenderMode="blocks" />,
    )
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    const md = render(
      <RoleplayContentRenderer content={FIXTURES.xss} contentRenderMode="markdown" />,
    )
    expect(md.container.querySelector('script')).toBeNull()
    expect(md.container.querySelector('img')).toBeNull()
  })

  it('单聊与群聊同一内容产生相同 dialogue DOM class', () => {
    const single = render(<MessageBubble message={msg(FIXTURES.standard)} character={char()} isLast={false} />)
    const group = render(<GroupChatMessage message={gmsg(FIXTURES.standard)} />)
    const s = single.container.querySelector('.dialogue-block')
    const g = group.container.querySelector('.dialogue-block')
    expect(s).toBeTruthy()
    expect(g).toBeTruthy()
    expect(s!.className).toContain('dialogue-block')
    expect(g!.className).toContain('dialogue-block')
    expect(s!.getAttribute('data-block-kind')).toBe(g!.getAttribute('data-block-kind'))
    expect(single.container.querySelector('.dialogue-speaker')?.textContent).toBe(
      group.container.querySelector('.dialogue-speaker')?.textContent,
    )
  })

  it('行内 Markdown 不泄漏符号', () => {
    const { container } = render(
      <RoleplayContentRenderer content={FIXTURES.inlineMd} contentRenderMode="blocks" />,
    )
    expect(container.textContent).toContain('粗体')
    expect(container.textContent).not.toContain('**')
    expect(container.querySelector('code')?.textContent).toBe('code()')
    expect(container.textContent).not.toContain('](')
  })
})
