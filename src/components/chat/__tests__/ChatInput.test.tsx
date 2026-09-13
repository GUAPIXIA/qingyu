import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, waitFor, act } from '@testing-library/react'
import { ChatInput } from '../ChatInput'
import { useChatStore } from '../../../store/useChatStore'
import { useSettingsStore } from '../../../store/useSettingsStore'
import { useCharacterStore } from '../../../store/useCharacterStore'
import { getDefaultSettings } from '../../../../shared/defaults'
import type { Character, Message, ConnectionProfile } from '../../../../shared/types'


/** 渲染并冲刷 mount 异步（quickReply 等 promise resolve 的 setState），避免 act 警告 */
async function renderChatInput(ui: React.ReactElement) {
  const utils = render(ui)
  await act(async () => {})
  return utils
}

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

function createMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    sessionId: 's1',
    characterId: 'char-1',
    role: 'user',
    content: 'Hello',
    images: [],
    isEditing: false,
    timestamp: Date.now(),
    ...overrides,
  }
}

const PROFILE: ConnectionProfile = {
  id: 'p1',
  name: 'profile',
  provider: 'openai',
  baseUrl: 'https://api.example.com',
  apiKey: 'sk-test',
  model: 'gpt-4o',
  maxContext: 8192,
}

type AiChunkHandler = Parameters<typeof window.api.ai.onChunk>[0]
type AiErrorHandler = Parameters<typeof window.api.ai.onError>[0]

function captureAiHelperCallbacks() {
  const handlers: {
    chunk?: AiChunkHandler
    done?: (requestId: string) => void
    error?: AiErrorHandler
  } = {}
  vi.mocked(window.api.ai.onChunk).mockImplementation((callback) => {
    handlers.chunk = callback
    return vi.fn()
  })
  vi.mocked(window.api.ai.onComplete).mockImplementation((callback) => {
    handlers.done = (requestId) => callback({ requestId, finishReason: 'stop' })
    return vi.fn()
  })
  vi.mocked(window.api.ai.onError).mockImplementation((callback) => {
    handlers.error = callback
    return vi.fn()
  })
  return handlers
}

function setupStores(connected = true) {
  useCharacterStore.setState({ characters: [createCharacter()] })
  useSettingsStore.setState({
    settings: {
      ...getDefaultSettings(),
      userName: 'TestUser',
      activeProfileId: connected ? 'p1' : null,
      connectionProfiles: connected ? [PROFILE] : [],
    },
    credentials: {},
    loaded: true,
    _saveTimer: null,
  })
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
    sendMessage: vi.fn().mockResolvedValue(undefined),
  })
}

describe('ChatInput', () => {
  beforeEach(() => {
    setupStores()
    vi.clearAllMocks()
    localStorage.clear()
    // quickReply IPC mock（useChatInputState 挂载时拉取）
    ;(window.api as any).quickReply = {
      listAll: vi.fn().mockResolvedValue({ global: [], byCharacter: {} }),
    }
  })

  describe('基础渲染', () => {
    it('渲染输入框和发送按钮', async () => {
      const { getByPlaceholderText, getByTitle } = await renderChatInput(<ChatInput character={createCharacter()} />)
      expect(getByPlaceholderText(/输入消息/)).toBeTruthy()
      expect(getByTitle('发送')).toBeTruthy()
    })

    it('未连接时显示配置提示', async () => {
      setupStores(false)
      const { getByPlaceholderText } = await renderChatInput(<ChatInput character={createCharacter()} />)
      expect(getByPlaceholderText(/请先在设置中配置 API 连接/)).toBeTruthy()
    })

    it('disabled 时禁用输入框', async () => {
      const { getByPlaceholderText } = await renderChatInput(<ChatInput character={createCharacter()} disabled />)
      expect((getByPlaceholderText(/输入消息/) as HTMLTextAreaElement).disabled).toBe(true)
    })
  })

  describe('发送逻辑', () => {
    it('空文本时发送按钮禁用', async () => {
      const { getByTitle } = await renderChatInput(<ChatInput character={createCharacter()} />)
      const sendBtn = getByTitle('发送')
      expect((sendBtn as HTMLButtonElement).disabled).toBe(true)
    })

    it('输入文本后发送按钮可用并调用 store.sendMessage', async () => {
      const { getByPlaceholderText, getByTitle } = await renderChatInput(<ChatInput character={createCharacter()} />)
      fireEvent.change(getByPlaceholderText(/输入消息/), { target: { value: '你好' } })
      const sendBtn = getByTitle('发送') as HTMLButtonElement
      expect(sendBtn.disabled).toBe(false)
      fireEvent.click(sendBtn)
      await waitFor(() => {
        expect(useChatStore.getState().sendMessage).toHaveBeenCalledWith(
          '你好', [], expect.objectContaining({ id: 'char-1' }), null, [], undefined, 'manual'
        )
      })
    })

    it('流式时显示停止按钮', async () => {
      useChatStore.setState({ isStreaming: true } as any)
      const { getByTitle, queryByTitle } = await renderChatInput(<ChatInput character={createCharacter()} />)
      expect(getByTitle('停止生成')).toBeTruthy()
      expect(queryByTitle('发送')).toBeNull()
    })
  })

  describe('引用回复（BUG-06 回归）', () => {
    it('显示被引用消息预览', async () => {
      const replyTo = createMessage({ content: '被引用的内容' })
      const { getByText } = await renderChatInput(
        <ChatInput character={createCharacter()} replyTo={replyTo} onCancelReply={vi.fn()} />
      )
      expect(getByText('被引用的内容')).toBeTruthy()
    })

    it('被引用消息 content 为空时不崩溃（BUG-06）', async () => {
      const replyTo = createMessage({ content: '' })
      const { container } = await renderChatInput(
        <ChatInput character={createCharacter()} replyTo={replyTo} onCancelReply={vi.fn()} />
      )
      expect(container).toBeTruthy()
    })

    it('点击取消按钮调用 onCancelReply', async () => {
      const onCancelReply = vi.fn()
      const replyTo = createMessage({ content: '内容' })
      const { getByTitle } = await renderChatInput(
        <ChatInput character={createCharacter()} replyTo={replyTo} onCancelReply={onCancelReply} />
      )
      fireEvent.click(getByTitle('取消引用'))
      expect(onCancelReply).toHaveBeenCalled()
    })
  })

  describe('图片预览', () => {
    it('渲染图片并可删除', async () => {
      // 通过 handleImageSelect 需要文件 mock，直接验证 UI 结构需要注入 images
      // useChatInputState 的 images 是内部 state，这里通过文件选择触发
      const { getByTitle, queryByAltText } = await renderChatInput(<ChatInput character={createCharacter()} />)
      // 无图片时不显示预览区
      expect(queryByAltText('')).toBeNull()
      expect(getByTitle('添加图片')).toBeTruthy()
    })
  })

  describe('AI 生图菜单', () => {
    it('按画面重点和我方入镜方式组织选项', async () => {
      const { getByTitle, getByText } = await renderChatInput(<ChatInput character={createCharacter()} />)

      fireEvent.click(getByTitle('AI 生图'))

      expect(getByText('画面重点')).toBeTruthy()
      expect(getByText('我方入镜')).toBeTruthy()
      expect(getByText('剧情瞬间')).toBeTruthy()
      expect(getByText('对方近景')).toBeTruthy()
      expect(getByText('对方全身')).toBeTruthy()
      expect(getByText('互动构图')).toBeTruthy()
      expect(getByText('环境空镜')).toBeTruthy()
      expect(getByText('不出现')).toBeTruthy()
      expect(getByText('仅轮廓')).toBeTruthy()
      expect(getByText('半透明')).toBeTruthy()
      expect(getByText('第一人称')).toBeTruthy()
    })

    it('把所选构图与入镜方式写入生图命令', async () => {
      const { getByTitle, getByRole, getByDisplayValue } = await renderChatInput(<ChatInput character={createCharacter()} />)

      fireEvent.click(getByTitle('AI 生图'))
      fireEvent.click(getByRole('button', { name: '仅轮廓' }))
      fireEvent.click(getByRole('button', { name: /互动构图/ }))

      expect(getByDisplayValue('/imagine --mode interaction --self silhouette')).toBeTruthy()
    })

    it('点击自定义描述后把焦点和光标放到命令末尾', async () => {
      const { getByTitle, getByRole, getByPlaceholderText } = await renderChatInput(<ChatInput character={createCharacter()} />)
      const input = getByPlaceholderText(/输入消息/) as HTMLTextAreaElement
      input.focus()
      input.setSelectionRange(0, 0)
      const selectionSpy = vi.spyOn(input, 'setSelectionRange')

      fireEvent.click(getByTitle('AI 生图'))
      fireEvent.click(getByRole('button', { name: /自定义描述/ }))

      await waitFor(() => {
        expect(document.activeElement).toBe(input)
        expect(input.value).toBe('/imagine ')
        expect(input.selectionStart).toBe(input.value.length)
        expect(input.selectionEnd).toBe(input.value.length)
        expect(selectionSpy).toHaveBeenCalledWith(input.value.length, input.value.length)
      })
    })
  })

  describe('快捷回复', () => {
    it('渲染快捷回复按钮', async () => {
      ;(window.api as any).quickReply.listAll = vi.fn().mockResolvedValue({
        global: [{ id: 'qr1', label: '早安', content: '早上好', action: 'text', hotkey: 1, enabled: true, order: 0 }],
        byCharacter: {},
      })
      const { findByText } = await renderChatInput(<ChatInput character={createCharacter()} />)
      expect(await findByText('早安')).toBeTruthy()
    })
  })

  describe('命令补全', () => {
    it('接收命令面板选择并填入斜杠命令模板', async () => {
      const { getByDisplayValue } = await renderChatInput(<ChatInput character={createCharacter()} />)

      act(() => {
        window.dispatchEvent(new CustomEvent('shortcut:insert-command', {
          detail: { value: '/imagine [提示词]' },
        }))
      })

      expect(getByDisplayValue('/imagine [提示词]')).toBeTruthy()
    })

    it('输入 / 前缀显示命令建议下拉', async () => {
      const { getByPlaceholderText, findByText } = await renderChatInput(<ChatInput character={createCharacter()} />)
      // 单个 '/' 无 token 不触发，输入 '/h' 匹配 help 命令
      fireEvent.change(getByPlaceholderText(/输入消息/), { target: { value: '/h' } })
      expect(await findByText(/\/help/, {}, { timeout: 2000 })).toBeTruthy()
    })
  })

  describe('AI 辅助', () => {
    it('润色按钮仅在输入非空时显示', async () => {
      const { queryByTitle, getByPlaceholderText } = await renderChatInput(<ChatInput character={createCharacter()} />)
      expect(queryByTitle('AI 润色输入文字')).toBeNull()
      fireEvent.change(getByPlaceholderText(/输入消息/), { target: { value: '测试文本' } })
      expect(queryByTitle('AI 润色输入文字')).toBeTruthy()
    })

    it('续写按钮始终显示', async () => {
      const { getByTitle, getByLabelText } = await renderChatInput(<ChatInput character={createCharacter()} />)
      expect(getByTitle('AI 根据上下文续写输入文字')).toBeTruthy()
      expect(getByTitle('AI 根据上下文续写输入文字')).toHaveClass('h-[30px]')
      expect(getByLabelText('续写设置')).toHaveClass('h-[30px]')
    })

    it('全局叙事续写保留完整输出预算，回填输入框后可由用户发送', async () => {
      const handlers = captureAiHelperCallbacks()
      useChatStore.setState({
        sessions: [{ id: 's1', characterId: 'char-1', narrativeMode: 'omniscient' } as never],
        messages: [createMessage({ role: 'assistant', content: '守卫封锁了通往港口的道路。' })],
      })
      const sendMessage = useChatStore.getState().sendMessage
      const { getByTitle, getByPlaceholderText } = await renderChatInput(<ChatInput character={createCharacter()} />)

      fireEvent.click(getByTitle('AI 根据上下文续写输入文字'))
      await waitFor(() => expect(window.api.ai.chat).toHaveBeenCalled())

      const params = vi.mocked(window.api.ai.chat).mock.calls.at(-1)?.[0]
      expect(params?.maxTokens).toBe(8192) // 统一失控兜底上限
      expect(params?.messages[0].content).toContain('剧情推进助手')

      // 落在默认「小段」档（80–180 字）内，避免触发长度补足修复
      const continuation = '就在封锁收紧时，城外忽然响起警钟，一封加急密令迫使守卫重新部署。艾莉丝皱着眉望向港口的方向，低声说码头西侧的旧闸门或许还留着一条水路，只要能在换岗前赶到，就有机会在不惊动任何人的情况下离开这座城。'
      await act(async () => {
        handlers.chunk?.({ requestId: params!.requestId, text: `<continuation>${continuation}</continuation>` })
        handlers.done?.(params!.requestId)
      })
      await waitFor(() => expect((getByPlaceholderText(/输入消息/) as HTMLTextAreaElement).value).toBe(continuation))

      fireEvent.click(getByTitle('发送'))
      await waitFor(() => {
        expect(sendMessage).toHaveBeenCalledWith(
          continuation, [], expect.objectContaining({ id: 'char-1' }), null, [], undefined, 'input_continue',
        )
      })
    })

    it('续写结果为空时在输入框上方显示可见反馈', async () => {
      const handlers = captureAiHelperCallbacks()
      useChatStore.setState({
        sessions: [{ id: 's1', characterId: 'char-1', narrativeMode: 'omniscient' } as never],
      })
      const { getByTitle, findByText } = await renderChatInput(<ChatInput character={createCharacter()} />)

      fireEvent.click(getByTitle('AI 根据上下文续写输入文字'))
      await waitFor(() => expect(window.api.ai.chat).toHaveBeenCalled())
      const requestId = vi.mocked(window.api.ai.chat).mock.calls.at(-1)?.[0].requestId

      await act(async () => {
        handlers.done?.(requestId!)
      })

      await waitFor(() => expect(window.api.ai.chat).toHaveBeenCalledTimes(2))
      const retryRequestId = vi.mocked(window.api.ai.chat).mock.calls.at(-1)?.[0].requestId
      await act(async () => {
        handlers.done?.(retryRequestId!)
      })

      // 模型只返回思考内容、没有正文时归因为“没有返回正文”
      expect(await findByText(/没有返回正文|未返回有效的中文正文/)).toBeTruthy()
    })

    it('代入模式连续输出角色视角内容时不回填输入框', async () => {
      const handlers = captureAiHelperCallbacks()
      useChatStore.setState({
        sessions: [{ id: 's1', characterId: 'char-1', narrativeMode: 'immersive' } as never],
      })
      const { getByTitle, getByPlaceholderText, findByText } = await renderChatInput(
        <ChatInput character={createCharacter()} />,
      )

      fireEvent.click(getByTitle('AI 根据上下文续写输入文字'))
      await waitFor(() => expect(window.api.ai.chat).toHaveBeenCalled())
      const params = vi.mocked(window.api.ai.chat).mock.calls.at(-1)?.[0]

      await act(async () => {
        handlers.chunk?.({ requestId: params!.requestId, text: '<continuation>Alice：你好呀，很高兴见到你。</continuation>' })
        handlers.done?.(params!.requestId)
      })

      await waitFor(() => expect(window.api.ai.chat).toHaveBeenCalledTimes(2))
      const retryParams = vi.mocked(window.api.ai.chat).mock.calls.at(-1)?.[0]
      await act(async () => {
        handlers.chunk?.({ requestId: retryParams!.requestId, text: '<continuation>Alice：你好呀，很高兴见到你。</continuation>' })
        handlers.done?.(retryParams!.requestId)
      })

      expect(await findByText('续写未返回有效的中文正文，请重试或更换模型')).toBeTruthy()
      // 输入框恢复原状，不回填角色台词
      expect((getByPlaceholderText(/输入消息/) as HTMLTextAreaElement).value).toBe('')
    })

    it('剧情变化与续写长度分别改变温度、输出预算和提示词', async () => {
      const handlers = captureAiHelperCallbacks()
      useSettingsStore.setState((s) => ({
        settings: { ...s.settings, continueIntensity: 'bold', continueLength: 'extended' },
      }))
      const { getByTitle } = await renderChatInput(<ChatInput character={createCharacter()} />)

      fireEvent.click(getByTitle('AI 根据上下文续写输入文字'))
      await waitFor(() => expect(window.api.ai.chat).toHaveBeenCalled())
      const params = vi.mocked(window.api.ai.chat).mock.calls.at(-1)?.[0]
      expect(params?.temperature).toBe(0.75)
      expect(params?.maxTokens).toBe(8192) // 统一失控兜底上限，不随档位变化
      expect(params?.messages[0].content).toContain('重大转折、场景变化或新的冲突方向')
      expect(params?.messages[0].content).toContain('写 500–900 个可见中文字符')
      await act(async () => {
        handlers.chunk?.({ requestId: params!.requestId, text: '<continuation>远处的警钟骤然响起。</continuation>' })
        handlers.done?.(params!.requestId)
      })
    })

    it('续写设置弹出面板：纯分段按钮写入全局设置，不再渲染隐形滑块', async () => {
      const { getByLabelText, getByRole, getByText, queryAllByRole } = await renderChatInput(
        <ChatInput character={createCharacter()} />,
      )

      fireEvent.click(getByLabelText('续写设置'))
      // 离散档位只保留按钮：弹出面板内不应出现滑块
      expect(queryAllByRole('slider')).toHaveLength(0)
      expect(getByText('本次续写长度')).toBeTruthy()
      expect(getByText('剧情变化')).toBeTruthy()

      fireEvent.click(getByRole('button', { name: '短句' }))
      expect(useSettingsStore.getState().settings.continueLength).toBe('brief')

      fireEvent.click(getByRole('button', { name: '延续' }))
      expect(useSettingsStore.getState().settings.continueIntensity).toBe('subtle')

      fireEvent.click(getByRole('button', { name: '长篇' }))
      expect(useSettingsStore.getState().settings.continueLength).toBe('extended')

      fireEvent.click(getByRole('button', { name: '剧变' }))
      expect(useSettingsStore.getState().settings.continueIntensity).toBe('bold')
    })

    it('显示当前档位的新增字数区间', async () => {
      useSettingsStore.setState((s) => ({ settings: { ...s.settings, continueLength: 'detailed' } }))
      const { getByLabelText, getByText } = await renderChatInput(<ChatInput character={createCharacter()} />)
      fireEvent.click(getByLabelText('续写设置'))
      expect(getByText('预计新增 220–420 字 · 2–3 个自然段')).toBeTruthy()
    })
  })
})
