import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, waitFor } from '@testing-library/react'
import { MessageBubble } from '../MessageBubble'
import { useChatStore } from '../../../store/useChatStore'
import { useSettingsStore } from '../../../store/useSettingsStore'
import { usePersonaStore } from '../../../store/usePersonaStore'
import { getDefaultSettings } from '../../../../shared/defaults'
import type { Message, Character } from '../../../../shared/types'

// 辅助函数：创建测试消息
function createMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    sessionId: 's1',
    characterId: 'char-1',
    role: 'assistant',
    content: 'Hello world',
    images: [],
    isEditing: false,
    timestamp: 1700000000000,
    ...overrides,
  }
}

// 辅助函数：创建测试角色
function createCharacter(overrides: Partial<Character> = {}): Character {
  return {
    id: 'char-1',
    name: 'Alice',
    avatar: '',
    description: '',
    personality: '',
    scenario: '',
    firstMessage: '',
    exampleDialog: '',
    tags: [],
    lorebookId: null,
    creator: '',
    createdAt: 0,
    updatedAt: 0,
    alternateGreetings: [],
    ...overrides,
  }
}

function setupStores() {
  useSettingsStore.setState({
    settings: { ...getDefaultSettings(), userName: 'TestUser' },
    credentials: {},
    loaded: true,
    _saveTimer: null,
  })
  usePersonaStore.setState({ personas: [], loaded: true })
  useChatStore.setState({
    messages: [],
    sessions: [],
    currentSessionId: 's1',
    isStreaming: false,
    error: null,
    activePresetId: null,
    activeLorebookIds: [],
    translatingMessages: {},
    showTranslationIds: new Set(),
  })
}

describe('MessageBubble', () => {
  beforeEach(() => {
    setupStores()
    vi.clearAllMocks()
    // clipboard mock
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    })
  })

  describe('基础渲染', () => {
    it('渲染角色消息内容', () => {
      const { getByText } = render(
        <MessageBubble message={createMessage({ content: '你好，世界' })} character={createCharacter()} isLast={false} />
      )
      expect(getByText('你好，世界')).toBeTruthy()
    })

    it('渲染角色显示名', () => {
      const { getByText } = render(
        <MessageBubble message={createMessage()} character={createCharacter({ name: 'Alice' })} isLast={false} />
      )
      expect(getByText('Alice')).toBeTruthy()
    })

    it('全局叙事的我方消息显示右侧旁白身份和中性气泡', () => {
      const { container, getByText, queryByText } = render(
        <MessageBubble message={createMessage({ role: 'user', narrativeMode: 'omniscient' })} character={createCharacter({ name: 'Alice' })} isLast={false} />
      )
      expect(getByText('旁白')).toBeTruthy()
      expect(getByText('推动焦点 · Alice')).toBeTruthy()
      expect(queryByText('TestUser')).toBeNull()
      expect(container.querySelector('.bubble-narrator')).toBeTruthy()
      expect(container.querySelector('.bubble-user')).toBeNull()
      expect(container.querySelector('.mx-auto.flex')?.classList.contains('flex-row-reverse')).toBe(true)
    })

    it('全局叙事的对方回复仍显示角色身份和角色气泡', () => {
      const { container, getByText, queryByText } = render(
        <MessageBubble message={createMessage({ role: 'assistant', narrativeMode: 'omniscient' })} character={createCharacter({ name: 'Alice' })} isLast={false} />
      )
      expect(getByText('Alice')).toBeTruthy()
      expect(queryByText('旁白')).toBeNull()
      expect(queryByText('推动焦点 · Alice')).toBeNull()
      expect(container.querySelector('.bubble-narrator')).toBeNull()
    })

    it('显式 speakerKind 优先于旧版叙事模式推导', () => {
      const { container, getByText, queryByText } = render(
        <MessageBubble
          message={createMessage({ role: 'user', narrativeMode: 'omniscient', speakerKind: 'character' })}
          character={createCharacter({ name: 'Alice' })}
          isLast={false}
        />,
      )
      expect(getByText('Alice')).toBeTruthy()
      expect(queryByText('旁白')).toBeNull()
      expect(container.querySelector('.bubble-narrator')).toBeNull()
      expect(container.querySelector('.bubble-user')).toBeNull()
      expect(container.querySelector('.mx-auto.flex')?.classList.contains('flex-row-reverse')).toBe(true)
    })

    it('用户消息使用用户侧气泡样式', () => {
      const { container } = render(
        <MessageBubble message={createMessage({ role: 'user', content: 'hi' })} character={createCharacter()} isLast={false} />
      )
      expect(container.querySelector('.bubble-user')).toBeTruthy()
    })

    it('用户短消息保持紧凑，消息宽度设置仅控制最大宽度', () => {
      useSettingsStore.setState((state) => ({
        settings: { ...state.settings, messageWidth: 480 },
      }))
      const { container } = render(
        <MessageBubble message={createMessage({ role: 'user', content: 'hi' })} character={createCharacter()} isLast={false} />
      )

      expect(container.querySelector('.bubble-user')?.classList.contains('w-fit')).toBe(true)
      expect(container.querySelector('.bubble-user')?.classList.contains('w-full')).toBe(false)
      expect((container.querySelector('.mx-auto.flex') as HTMLElement)?.style.maxWidth).toBe('480px')
    })

    it('系统消息不渲染对话正文', () => {
      const { queryByText } = render(
        <MessageBubble message={createMessage({ role: 'system', content: '生成结果' })} character={createCharacter()} isLast={false} />
      )
      // system 消息正文不显示（只显示图片）
      expect(queryByText('生成结果')).toBeNull()
    })

    it('空消息显示占位文本', () => {
      const { getByText } = render(
        <MessageBubble message={createMessage({ content: '' })} character={createCharacter()} isLast={false} />
      )
      expect(getByText('（空消息）')).toBeTruthy()
    })

    it('markdown 内容被渲染', () => {
      const { getByText } = render(
        <MessageBubble message={createMessage({ content: '**加粗**文本' })} character={createCharacter()} isLast={false} />
      )
      expect(getByText('加粗')).toBeTruthy()
    })
  })

  describe('引用回复（BUG-05 回归）', () => {
    it('显示被引用消息的内容摘要', () => {
      const replied = createMessage({ id: 'replied-1', role: 'user', content: '被引用的内容' })
      const { getByText } = render(
        <MessageBubble message={createMessage()} character={createCharacter()} isLast={false} repliedMessage={replied} />
      )
      expect(getByText('被引用的内容')).toBeTruthy()
    })

    it('被引用消息 content 为空时不崩溃（BUG-05）', () => {
      const replied = createMessage({ id: 'replied-1', role: 'user', content: '' })
      const { container } = render(
        <MessageBubble message={createMessage()} character={createCharacter()} isLast={false} repliedMessage={replied} />
      )
      expect(container).toBeTruthy()
    })

    it('长内容截断为 80 字符并显示省略号', () => {
      const longContent = 'x'.repeat(120)
      const replied = createMessage({ id: 'replied-1', role: 'user', content: longContent })
      const { container } = render(
        <MessageBubble message={createMessage()} character={createCharacter()} isLast={false} repliedMessage={replied} />
      )
      // 相邻文本节点被 React 合并，用容器文本断言
      expect(container.textContent).toContain('...')
      expect(container.textContent).toContain('x'.repeat(80))
    })
  })

  describe('内心想法（thought）折叠', () => {
    it('显示折叠按钮并可展开内容', () => {
      const msg = createMessage({ content: '<thought>内心独白</thought>正文内容' })
      const { getByText, queryByText } = render(
        <MessageBubble message={msg} character={createCharacter()} isLast={false} />
      )
      expect(getByText('💭 内心想法')).toBeTruthy()
      // 默认折叠：内容不可见
      expect(queryByText('内心独白')).toBeNull()
      // 展开
      fireEvent.click(getByText('💭 内心想法'))
      expect(getByText('内心独白')).toBeTruthy()
    })
  })

  describe('图片消息', () => {
    it('纯图片系统消息不渲染正文', () => {
      const msg = createMessage({
        role: 'system',
        content: '图片描述',
        images: ['data:image/png;base64,AAAA'],
      })
      const { queryByText } = render(
        <MessageBubble message={msg} character={createCharacter()} isLast={false} />
      )
      expect(queryByText('图片描述')).toBeNull()
    })

    it('保存了提示词的系统图片仍使用紧凑纯图片布局', () => {
      const msg = createMessage({
        role: 'system',
        content: 'A cinematic portrait prompt',
        images: ['data:image/png;base64,AAAA'],
      })
      const { container } = render(
        <MessageBubble message={msg} character={createCharacter()} isLast={false} />
      )
      expect(container.querySelector('[data-image-only="true"]')).toBeTruthy()
    })

    it('右键生成图片可查看生图提示词', () => {
      const msg = createMessage({
        role: 'system',
        content: 'cinematic portrait, warm rim light',
        images: ['data:image/png;base64,AAAA'],
      })
      const { getByRole, getByText } = render(
        <MessageBubble message={msg} character={createCharacter()} isLast={false} />
      )

      fireEvent.contextMenu(getByRole('img', { name: '生成图片 1' }), { clientX: 120, clientY: 80 })
      fireEvent.click(getByRole('menuitem', { name: '查看生图提示词' }))

      expect(getByRole('dialog', { name: '生图提示词' })).toBeTruthy()
      expect(getByText('cinematic portrait, warm rim light')).toBeTruthy()
    })

    it('右键重新生成时只替换当前图片', async () => {
      const updateMessageImages = vi.fn().mockResolvedValue(undefined)
      useChatStore.setState({ updateMessageImages } as any)
      vi.mocked(window.api.imageGen.generate).mockResolvedValueOnce({
        success: true,
        images: ['data:image/png;base64,NEW'],
      })
      const msg = createMessage({
        role: 'system',
        content: 'cinematic portrait, warm rim light',
        images: ['data:image/png;base64,AAAA', 'data:image/png;base64,BBBB'],
      })
      const { getAllByRole, getByRole } = render(
        <MessageBubble message={msg} character={createCharacter()} isLast={false} />
      )

      fireEvent.contextMenu(getAllByRole('img')[0], { clientX: 120, clientY: 80 })
      fireEvent.click(getByRole('menuitem', { name: '重新生成图片' }))

      expect(window.api.imageGen.generate).toHaveBeenCalledWith('cinematic portrait, warm rim light')
      await waitFor(() => {
        expect(updateMessageImages).toHaveBeenCalledWith('msg-1', [
          'data:image/png;base64,NEW',
          'data:image/png;base64,BBBB',
        ])
      })
    })

    it('右键删除多图消息中的单张图片并保留消息', async () => {
      const updateMessageImages = vi.fn().mockResolvedValue(undefined)
      const deleteMessage = vi.fn().mockResolvedValue(undefined)
      useChatStore.setState({ updateMessageImages, deleteMessage } as any)
      const msg = createMessage({
        role: 'system',
        content: 'a cat',
        images: ['data:image/png;base64,AAAA', 'data:image/png;base64,BBBB'],
      })
      const { getAllByRole, getByRole } = render(
        <MessageBubble message={msg} character={createCharacter()} isLast={false} />
      )

      fireEvent.contextMenu(getAllByRole('img')[0], { clientX: 120, clientY: 80 })
      fireEvent.click(getByRole('menuitem', { name: '删除图片' }))

      await waitFor(() => {
        expect(updateMessageImages).toHaveBeenCalledWith('msg-1', ['data:image/png;base64,BBBB'])
      })
      expect(deleteMessage).not.toHaveBeenCalled()
    })

    it('右键删除最后一张生成图片时删除整条消息', async () => {
      const deleteMessage = vi.fn().mockResolvedValue(undefined)
      useChatStore.setState({ deleteMessage } as any)
      const character = createCharacter()
      const msg = createMessage({
        role: 'system',
        content: 'a cat',
        images: ['data:image/png;base64,AAAA'],
      })
      const { getByRole } = render(
        <MessageBubble message={msg} character={character} isLast={false} />
      )

      fireEvent.contextMenu(getByRole('img', { name: '生成图片 1' }), { clientX: 120, clientY: 80 })
      fireEvent.click(getByRole('menuitem', { name: '删除图片' }))

      await waitFor(() => {
        expect(deleteMessage).toHaveBeenCalledWith('msg-1', character)
      })
    })
  })

  describe('操作栏', () => {
    it('编辑按钮打开编辑态', () => {
      const { getByTitle, getByText } = render(
        <MessageBubble message={createMessage()} character={createCharacter()} isLast={false} />
      )
      fireEvent.click(getByTitle('编辑'))
      expect(getByText('保存')).toBeTruthy()
    })

    it('复制按钮调用 clipboard API（BUG-31）', async () => {
      const msg = createMessage({ content: '要复制的内容' })
      const { getByTitle } = render(
        <MessageBubble message={msg} character={createCharacter()} isLast={false} />
      )
      fireEvent.click(getByTitle('复制'))
      await waitFor(() => {
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith('要复制的内容')
      })
    })

    it('删除按钮调用 store.deleteMessage', () => {
      const deleteMessage = vi.fn().mockResolvedValue(undefined)
      useChatStore.setState({ deleteMessage } as any)
      const { getByTitle } = render(
        <MessageBubble message={createMessage()} character={createCharacter()} isLast={false} />
      )
      fireEvent.click(getByTitle('删除'))
      expect(deleteMessage).toHaveBeenCalledWith('msg-1', expect.anything())
    })

    it('新建分支沿用原会话名称，不再截取消息正文', async () => {
      const msg = createMessage({ content: '这段消息正文不应该成为分支名称' })
      useChatStore.setState({
        messages: [msg],
        sessions: [{ id: 's1', title: '雨夜重逢' }],
        currentSessionId: 's1',
      } as any)

      const { getByTitle } = render(
        <MessageBubble message={msg} character={createCharacter()} isLast={false} />
      )
      fireEvent.click(getByTitle('从此处分支'))

      await waitFor(() => {
        expect(window.api.chat.createSession).toHaveBeenCalledWith('char-1', '雨夜重逢 · 分支')
      })
    })

    it('流式时隐藏操作栏', () => {
      useChatStore.setState({ isStreaming: true } as any)
      const { queryByTitle } = render(
        <MessageBubble message={createMessage()} character={createCharacter()} isLast={true} />
      )
      expect(queryByTitle('编辑')).toBeNull()
      expect(queryByTitle('删除')).toBeNull()
    })
  })

  describe('Swipe 候选', () => {
    it('多条候选时显示切换指示器', () => {
      const msg = createMessage({
        swipes: ['候选1', '候选2'],
        swipeIndex: 0,
      })
      const { getByText } = render(
        <MessageBubble message={msg} character={createCharacter()} isLast={false} />
      )
      expect(getByText('1/2')).toBeTruthy()
    })

    it('单条候选不显示指示器', () => {
      const msg = createMessage({ content: '仅一条' })
      const { queryByText } = render(
        <MessageBubble message={msg} character={createCharacter()} isLast={false} />
      )
      expect(queryByText('1/1')).toBeNull()
    })
  })

  describe('翻译状态', () => {
    it('翻译中显示加载指示', () => {
      useChatStore.setState({
        translatingMessages: { 'msg-1': { status: 'translating', content: '' } },
      } as any)
      const { getByText } = render(
        <MessageBubble message={createMessage()} character={createCharacter()} isLast={false} />
      )
      expect(getByText('翻译中...')).toBeTruthy()
    })

    it('翻译失败显示错误信息', () => {
      useChatStore.setState({
        translatingMessages: { 'msg-1': { status: 'error', content: '', errorMsg: '网络错误' } },
        showTranslationIds: new Set(['msg-1']),
      } as any)
      const { getByText } = render(
        <MessageBubble message={createMessage()} character={createCharacter()} isLast={false} />
      )
      expect(getByText(/翻译失败/)).toBeTruthy()
    })

    it('翻译完成且显示开关打开时显示译文而非原文', () => {
      useChatStore.setState({
        translatingMessages: { 'msg-1': { status: 'done', content: '你好世界' } },
        showTranslationIds: new Set(['msg-1']),
      } as any)
      const { getByText, queryByText } = render(
        <MessageBubble message={createMessage({ content: 'Hello world' })} character={createCharacter()} isLast={false} />
      )
      expect(getByText('你好世界')).toBeTruthy()
      expect(queryByText('Hello world')).toBeNull()
    })

    it('内存翻译状态丢失时回退显示持久化的 message.translation', () => {
      useChatStore.setState({
        translatingMessages: {},
        showTranslationIds: new Set(['msg-1']),
      } as any)
      const { getByText, queryByText } = render(
        <MessageBubble message={createMessage({ content: 'Hello world', translation: '你好世界' })} character={createCharacter()} isLast={false} />
      )
      expect(getByText('你好世界')).toBeTruthy()
      expect(queryByText('Hello world')).toBeNull()
    })
  })

  describe('下一步方向卡片', () => {
    const directions = [
      { id: 'safe', label: '追问封锁原因', content: '先不与守卫冲突，试着追问港口突然封锁的原因。', tendency: 'safe' as const },
      { id: 'explore', label: '寻找其他入口', content: '暂时离开正门，沿港口外围查看是否存在无人值守的通道。', tendency: 'explore' as const },
      { id: 'risky', label: '冒险直接闯关', content: '趁守卫注意力被分散时尝试突破封锁，承担立即暴露的风险。', tendency: 'risky' as const },
    ]

    it('会话开启且消息带方向时渲染卡片，点选回填输入框草稿', async () => {
      const { registerDraftBridge } = await import('../draftBridge')
      let draft = ''
      const setDraft = vi.fn((value: string) => { draft = value })
      registerDraftBridge('single', { getText: () => draft, setDraft })

      useChatStore.setState({
        sessions: [{ id: 's1', characterId: 'char-1', dialogueDirectionsEnabled: true } as never],
        currentSessionId: 's1',
      })
      const { getByRole } = render(
        <MessageBubble
          message={createMessage({ dialogueDirections: directions })}
          character={createCharacter()}
          isLast
        />,
      )

      fireEvent.click(getByRole('button', { name: /追问封锁原因/ }))
      expect(setDraft).toHaveBeenCalledWith(directions[0].content)
      expect(draft).toBe(directions[0].content)
      registerDraftBridge('single', null)
    })

    it('会话未开启方向时不渲染卡片', () => {
      useChatStore.setState({
        sessions: [{ id: 's1', characterId: 'char-1', dialogueDirectionsEnabled: false } as never],
        currentSessionId: 's1',
      })
      const { queryByText } = render(
        <MessageBubble
          message={createMessage({ dialogueDirections: directions })}
          character={createCharacter()}
          isLast
        />,
      )
      expect(queryByText('选择下一步方向')).toBeNull()
    })

    it('流式生成中不渲染卡片', () => {
      useChatStore.setState({
        sessions: [{ id: 's1', characterId: 'char-1', dialogueDirectionsEnabled: true } as never],
        currentSessionId: 's1',
        isStreaming: true,
      })
      const { queryByText } = render(
        <MessageBubble
          message={createMessage({ dialogueDirections: directions })}
          character={createCharacter()}
          isLast
        />,
      )
      expect(queryByText('选择下一步方向')).toBeNull()
    })
  })
})
