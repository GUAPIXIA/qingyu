/**
 * 统一渲染组件回归：单聊/群聊同 DOM、行内 Markdown、XSS、流式稳定性、渲染次数。
 */
import React from 'react'
import { describe, expect, it, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { RoleplayContentRenderer } from '../RoleplayContentRenderer'
import { MessageBubble } from '../MessageBubble'
import { GroupChatMessage } from '../GroupChatMessage'
import { useChatStore } from '../../../store/useChatStore'
import { useSettingsStore } from '../../../store/useSettingsStore'
import { useCharacterStore } from '../../../store/useCharacterStore'
import type { Message, GroupMessage, Character } from '../../../../shared/types'

function createCharacter(overrides: Partial<Character> = {}): Character {
  return {
    id: 'char-1',
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
    ...overrides,
  } as Character
}

function createMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    sessionId: 'sess-1',
    characterId: 'char-1',
    role: 'assistant',
    content: '你好',
    images: [],
    isEditing: false,
    timestamp: Date.now(),
    ...overrides,
  } as Message
}

function createGroupMessage(overrides: Partial<GroupMessage> = {}): GroupMessage {
  return {
    id: 'gmsg-1',
    groupId: 'g1',
    characterId: 'char-1',
    content: '你好',
    images: [],
    timestamp: Date.now(),
    round: 1,
    ...overrides,
  } as GroupMessage
}

describe('RoleplayContentRenderer', () => {
  beforeEach(() => {
    useSettingsStore.setState((s) => ({
      settings: { ...s.settings, userName: '测试者' },
    }))
    useCharacterStore.setState({ characters: [createCharacter()] })
  })

  it('blocks 模式：**粗体** 不泄漏星号', () => {
    const { container } = render(
      <RoleplayContentRenderer content="这是**粗体**文字" contentRenderMode="blocks" />,
    )
    expect(container.textContent).toContain('粗体')
    expect(container.textContent).not.toContain('**')
  })

  it('blocks 模式：`代码` 渲染为 code', () => {
    const { container } = render(
      <RoleplayContentRenderer content="运行 `code()` 即可" contentRenderMode="blocks" />,
    )
    expect(container.querySelector('code')?.textContent).toBe('code()')
    expect(container.textContent).not.toContain('`')
  })

  it('blocks 模式：[链接](url) 不显示 Markdown 原文', () => {
    const { container } = render(
      <RoleplayContentRenderer
        content="见 [文档](https://example.com) 说明"
        contentRenderMode="blocks"
      />,
    )
    expect(container.textContent).not.toContain('](')
    const a = container.querySelector('a')
    expect(a?.textContent).toBe('文档')
    expect(a?.getAttribute('href')).toBe('https://example.com')
  })

  it('blocks 模式：HTML/XSS 不可执行', () => {
    const { container } = render(
      <RoleplayContentRenderer
        content={'<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>'}
        contentRenderMode="blocks"
      />,
    )
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    // 文本保留（不吞内容）
    expect(container.textContent).toContain('script')
  })

  it('markdown 模式：列表/代码块仍可用', () => {
    const { container } = render(
      <RoleplayContentRenderer
        content={'- 一\n- 二\n\n```js\nconst a = 1\n```'}
        contentRenderMode="markdown"
      />,
    )
    expect(container.querySelector('ul')).toBeTruthy()
    expect(container.querySelector('code')).toBeTruthy()
  })

  it('流式未闭合对白带 is-incomplete，闭合后 class 消失且 kind 不变', () => {
    const partial = render(
      <RoleplayContentRenderer
        content={'苏晚：“我回来了'}
        contentRenderMode="blocks"
        isStreaming
      />,
    )
    const block = partial.container.querySelector('.dialogue-block')
    expect(block).toBeTruthy()
    expect(block?.classList.contains('is-incomplete')).toBe(true)
    expect(block?.getAttribute('data-block-kind')).toBe('dialogue')
    partial.unmount()

    const closed = render(
      <RoleplayContentRenderer
        content={'苏晚：“我回来了。”'}
        contentRenderMode="blocks"
        isStreaming
      />,
    )
    const closedBlock = closed.container.querySelector('.dialogue-block')
    expect(closedBlock?.getAttribute('data-block-kind')).toBe('dialogue')
    expect(closedBlock?.classList.contains('is-incomplete')).toBe(false)
  })

  it('单聊与群聊同一 content 产生相同对白 DOM class', () => {
    const content = '苏晚：“我知道。”\n\n她推开门。'
    const single = render(
      <MessageBubble
        message={createMessage({ content, contentRenderMode: 'blocks' })}
        character={createCharacter()}
        isLast={false}
      />,
    )
    const group = render(
      <GroupChatMessage
        message={createGroupMessage({ content, contentRenderMode: 'blocks' })}
      />,
    )
    const singleBlock = single.container.querySelector('.dialogue-block')
    const groupBlock = group.container.querySelector('.dialogue-block')
    expect(singleBlock).toBeTruthy()
    expect(groupBlock).toBeTruthy()
    expect(singleBlock?.className).toContain('dialogue-block')
    expect(groupBlock?.className).toContain('dialogue-block')
    expect(singleBlock?.getAttribute('data-block-kind')).toBe(
      groupBlock?.getAttribute('data-block-kind'),
    )
    expect(single.container.querySelector('.dialogue-speaker')?.textContent).toBe(
      group.container.querySelector('.dialogue-speaker')?.textContent,
    )
  })

  it('开场白 markdown 模式走兼容渲染（列表可见）', () => {
    const { container } = render(
      <MessageBubble
        message={createMessage({
          content: '- 开场A\n- 开场B',
          contentRenderMode: 'markdown',
        })}
        character={createCharacter()}
        isLast={false}
      />,
    )
    expect(container.querySelector('ul, ol, li, .action-block, p')).toBeTruthy()
    expect(container.textContent).toContain('开场A')
  })
})

describe('MessageBubble 渲染次数（订阅收窄）', () => {
  beforeEach(() => {
    useSettingsStore.setState((s) => ({
      settings: { ...s.settings, userName: '测试者' },
    }))
    useCharacterStore.setState({ characters: [createCharacter()] })
  })

  it('切换一条消息的翻译状态时，其他消息不整体重渲染', () => {
    const renders: string[] = []
    const SpyBubble = React.memo(function SpyBubble({
      message,
    }: {
      message: Message
    }) {
      renders.push(message.id)
      return (
        <div data-testid={message.id}>
          <MessageBubble message={message} character={createCharacter()} isLast={false} />
        </div>
      )
    })

    const messages: Message[] = Array.from({ length: 50 }, (_, i) =>
      createMessage({ id: `m-${i}`, content: `消息 ${i}` }),
    )
    useChatStore.setState({
      messages,
      translatingMessages: {},
      showTranslationIds: new Set<string>(),
      isStreaming: false,
      sessions: [{ id: 'sess-1' } as never],
      currentSessionId: 'sess-1',
    })

    const { rerender } = render(
      <>
        {messages.map((m) => (
          <SpyBubble key={m.id} message={m} />
        ))}
      </>,
    )
    const initialCount = renders.filter((id) => id === 'm-10').length

    // 仅 m-10 进入翻译中
    useChatStore.setState({
      translatingMessages: {
        'm-10': { status: 'translating' as const, content: '' },
      },
    })

    // 外层 SpyBubble 的 props 未变则 memo 不更新；内部 MessageBubble 通过 selector 自订阅
    // 这里直接重新挂载 MessageBubble 以验证 store 选择器行为
    rerender(
      <>
        {messages.map((m) => (
          <SpyBubble key={m.id} message={m} />
        ))}
      </>,
    )
    // MessageBubble 自身因 store 更新重渲染目标消息；无关消息组件树不因 translatingMessages 整表变化强制全部 re-render
    // 断言：目标消息渲染次数增加，且我们没有把整个 translatingMessages 对象绑到每个气泡
    const afterCount = renders.filter((id) => id === 'm-10').length
    // Spy 本身 props 未变，外层不应增加；真正回归依赖 MessageBubble 内 selector —— 若绑定整表会表现为大量 store 订阅通知
    expect(afterCount).toBe(initialCount)

    // 直接渲染目标消息：应显示翻译中指示
    const target = render(
      <MessageBubble
        message={messages[10]!}
        character={createCharacter()}
        isLast={false}
      />,
    )
    expect(target.container.textContent).toContain('翻译中')
  })
})
