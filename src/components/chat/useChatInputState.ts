import { useState, useRef, useEffect } from 'react'
import type { KeyboardEvent } from 'react'
import { useChatStore } from '../../store/useChatStore'
import { useSettingsStore } from '../../store/useSettingsStore'
import { logError } from '../../lib/logger'
import { isConnectionConfigured } from '../../utils/defaults'
import { getDisplayName } from '../../utils/variables'
import { expandMacros, buildMacroContext } from '../../utils/macros'
import { getEffectiveQuickReplies } from '../../utils/quickReply'
import type { Character, Preset, Lorebook, QuickReply, QuickReplyStore, Message } from '../../../shared/types'
import { findCommand, listCommands, type CommandContext } from '../../commands/registry'
import { parseCommand } from '../../commands/parser'
import { registerBuiltinCommands } from '../../commands/builtin'
import { callAiHelper as callAiHelperCore, ensureUserPerspective, buildContinueContext } from './aiInputHelper'
import { createCommandContext } from './commandContext'

// 初始化内置命令（只执行一次）
let commandsInitialized = false
function ensureCommandsInitialized() {
  if (!commandsInitialized) {
    registerBuiltinCommands()
    commandsInitialized = true
  }
}

/** 草稿存储 key（按角色 ID + 会话 ID 隔离） */
function draftKey(characterId: string, sessionId?: string | null) {
  return `chat-draft:${characterId}:${sessionId || 'default'}`
}

export interface ChatInputState {
  text: string
  setText: (v: string) => void
  images: string[]
  setImages: (v: string[]) => void
  isAiProcessing: boolean
  originalText: string | null
  setOriginalText: (v: string | null) => void
  commandSuggestions: { name: string; description: string; usage: string }[]
  setCommandSuggestions: (v: { name: string; description: string; usage: string }[]) => void
  selectedSuggestionIdx: number
  setSelectedSuggestionIdx: (v: number) => void
  imageMenuOpen: boolean
  setImageMenuOpen: (v: boolean | ((prev: boolean) => boolean)) => void
  notification: string | null
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  effectiveReplies: QuickReply[]
  isConnected: boolean
  isStreaming: boolean
  stopStreaming: () => void
  runQuickReply: (qr: QuickReply) => Promise<void>
  showNotification: (msg: string) => void
  buildCommandContext: () => CommandContext
  handleSend: () => Promise<void>
  handleKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void
  handleImageSelect: () => Promise<void>
  removeImage: (index: number) => void
  handleAiContinue: () => Promise<void>
  handleAiPolish: () => Promise<void>
  settings: ReturnType<typeof useSettingsStore.getState>['settings']
}

/**
 * ChatInput 的全部状态与逻辑（输入 / 草稿 / 命令 / 快捷回复 / AI 辅助）。
 * 拆出后组件层只负责渲染，逻辑可独立测试。
 */
export function useChatInputState(
  character: Character,
  replyTo?: Message | null,
  onCancelReply?: () => void,
): ChatInputState {
  // 初始化内置命令
  ensureCommandsInitialized()

  // P-6 修复：字段级选择器订阅——此前无选择器订阅整个 store，
  // 流式 flush（50ms 一次）时输入框整体重渲染
  const currentSessionId = useChatStore((s) => s.currentSessionId)
  const [text, setText] = useState(() => {
    // 启动时恢复草稿
    try {
      return localStorage.getItem(draftKey(character.id, currentSessionId)) ?? ''
    } catch {
      return ''
    }
  })
  const [images, setImages] = useState<string[]>([])
  const [isAiProcessing, setIsAiProcessing] = useState(false)
  const [originalText, setOriginalText] = useState<string | null>(null)
  // 命令补全建议
  const [commandSuggestions, setCommandSuggestions] = useState<Array<{ name: string; description: string; usage: string }>>([])
  const [selectedSuggestionIdx, setSelectedSuggestionIdx] = useState(0)
  const [imageMenuOpen, setImageMenuOpen] = useState(false)
  // 短暂通知（命令执行反馈）
  const [notification, setNotification] = useState<string | null>(null)
  const notificationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 快捷回复
  const [qrStore, setQrStore] = useState<QuickReplyStore>({ global: [], byCharacter: {} })
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // H-09 修复：追踪活跃的 AI 辅助请求，组件卸载时取消
  const activeRequestIdsRef = useRef<Set<string>>(new Set())
  const sendMessage = useChatStore((s) => s.sendMessage)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const stopStreaming = useChatStore((s) => s.stopStreaming)
  const settings = useSettingsStore((s) => s.settings)
  const getActiveProfile = useSettingsStore((s) => s.getActiveProfile)

  const activeProfile = getActiveProfile()
  const isConnected = isConnectionConfigured(activeProfile)

  // 快捷回复按钮：角色/会话切换时刷新
  useEffect(() => {
    let canceled = false
    window.api.quickReply.listAll().then((s) => {
      if (!canceled) setQrStore(s)
    }).catch(() => { /* 忽略 */ })
    return () => { canceled = true }
  }, [character.id, currentSessionId])

  const effectiveReplies = getEffectiveQuickReplies(qrStore, character.id)

  // 显示通知（3 秒后自动消失）
  const showNotification = (msg: string) => {
    setNotification(msg)
    if (notificationTimerRef.current) clearTimeout(notificationTimerRef.current)
    notificationTimerRef.current = setTimeout(() => setNotification(null), 3000)
  }

  /** 加载当前选中的预设和所有激活的世界书（P-7：委托给 store 的 getActiveChatConfig，同时更新缓存） */
  const loadActivePresetLorebook = async (): Promise<[Preset | null, Lorebook[]]> => {
    const { preset, lorebooks } = await useChatStore.getState().getActiveChatConfig()
    return [preset, lorebooks]
  }

  /** 执行一条快捷回复（宏展开 + 动作分发） */
  const runQuickReply = async (qr: QuickReply) => {
    try {
      // 消费当前引用（快捷回复发送时清除引用条）
      if (replyTo) onCancelReply?.()
      if (qr.action === 'preset' && qr.presetId) {
        useChatStore.getState().setActivePreset(qr.presetId, character.id)
        showNotification('已切换预设')
        return
      }
      if (qr.action === 'command' && qr.command?.trim().startsWith('/')) {
        const parsed = parseCommand(qr.command.trim())
        const cmd = parsed && findCommand(parsed.name)
        if (cmd) {
          await cmd.execute(parsed.args, buildCommandContext())
          return
        }
      }
      // text：宏展开后发送
      const chatStore = useChatStore.getState()
      const macroCtx = buildMacroContext(chatStore.messages, {
        userName: settings.userName || '用户',
        // M-26 修复：charName 应为译名优先、originalCharName 为原名（与全库约定一致），此前传反
        charName: character.translatedContent?.name || character.name,
        originalCharName: character.name,
      })
      const content = expandMacros(qr.content, macroCtx).trim()
      if (!content) return
      if (qr.sendWithAI) {
        const [preset, lorebooks] = await loadActivePresetLorebook()
        await chatStore.sendMessage(content, [], character, preset, lorebooks)
      } else {
        await chatStore.addStandaloneMessage(content, [], character, 'user')
      }
    } catch (e) {
      showNotification(`快捷回复执行失败: ${(e as Error).message}`)
    }
  }

  // 构建命令上下文（逻辑抽取至 commandContext.ts）
  const buildCommandContext = (): CommandContext => createCommandContext({
    character,
    loadActivePresetLorebook,
    showNotification,
    callAiHelper,
  })

  // 命令补全：检测 / 开头时显示建议
  useEffect(() => {
    if (!text.startsWith('/')) {
      setCommandSuggestions([])
      setSelectedSuggestionIdx(0)
      return
    }
    const parsed = parseCommand(text)
    if (!parsed) return
    // 命令名补全（输入 /cl 时提示 /clear）
    if (!text.includes(' ')) {
      const matches = listCommands()
        .filter(c => c.name.startsWith(parsed.name))
        .map(c => ({ name: c.name, description: c.description, usage: c.usage }))
      setCommandSuggestions(matches)
      setSelectedSuggestionIdx(0)
      return
    }
    // 参数补全（命令已确定）
    const cmd = findCommand(parsed.name)
    if (cmd?.args?.[0]?.complete) {
      const ctx = buildCommandContext()
      const lastArg = parsed.args[parsed.args.length - 1] ?? ''
      Promise.resolve(cmd.args[0].complete(lastArg, ctx)).then(options => {
        setCommandSuggestions(options.map(o => ({ name: o, description: '', usage: '' })))
        setSelectedSuggestionIdx(0)
      })
    } else {
      setCommandSuggestions([])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text])

  // 切换角色/会话时重新加载草稿
  useEffect(() => {
    try {
      setText(localStorage.getItem(draftKey(character.id, currentSessionId)) ?? '')
    } catch {
      setText('')
    }
    setImages([])
    setOriginalText(null)
  }, [character.id, currentSessionId])

  // 自动保存草稿（防抖）
  useEffect(() => {
    if (!text) {
      try { localStorage.removeItem(draftKey(character.id, currentSessionId)) } catch { /* ignore */ }
      return
    }
    const timer = setTimeout(() => {
      try { localStorage.setItem(draftKey(character.id, currentSessionId), text) } catch { /* ignore */ }
    }, 300)
    return () => clearTimeout(timer)
  }, [text, character.id, currentSessionId])

  // P-10 修复：用 requestAnimationFrame 避免同步 reflow
  useEffect(() => {
    if (textareaRef.current) {
      requestAnimationFrame(() => {
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto'
          textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + 'px'
        }
      })
    }
  }, [text])

  // H-09 修复：组件卸载时取消所有活跃的 AI 辅助请求并清理 IPC 监听器
  useEffect(() => {
    const ref = activeRequestIdsRef
    return () => {
      const ids = Array.from(ref.current)
      for (const id of ids) {
        window.api.ai.cancelChat(id).catch((e) => logError('ChatInput:cancelChat', e))
      }
      ref.current.clear()
    }
  }, [])

  const handleSend = async () => {
    if (!text.trim() || isStreaming) return

    // 命令解析：以 / 开头优先尝试作为命令执行
    if (text.startsWith('/')) {
      const parsed = parseCommand(text)
      if (parsed) {
        const cmd = findCommand(parsed.name)
        if (cmd) {
          setText('')
          setImages([])
          setOriginalText(null)
          setCommandSuggestions([])
          try { localStorage.removeItem(draftKey(character.id, currentSessionId)) } catch { /* ignore */ }
          try {
            await cmd.execute(parsed.args, buildCommandContext())
          } catch (err) {
            showNotification(`命令执行失败: ${(err as Error).message}`)
          }
          return
        }
        // 未知命令：作为普通消息发送（让 AI 看到 /xxx）
      }
    }

    // 普通消息发送
    const content = text.trim()
    const imgs = [...images]
    setText('')
    setImages([])
    setOriginalText(null)
    // 清除草稿
    try { localStorage.removeItem(draftKey(character.id, currentSessionId)) } catch { /* ignore */ }
    const [preset, lorebooks] = await loadActivePresetLorebook()
    const replyId = replyTo?.id ?? undefined
    onCancelReply?.()
    await sendMessage(content, imgs, character, preset, lorebooks, replyId)
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // 命令补全：Tab 补全第一个建议
    if (e.key === 'Tab' && commandSuggestions.length > 0) {
      e.preventDefault()
      const suggestion = commandSuggestions[selectedSuggestionIdx]
      if (suggestion) {
        // 命令名补全：替换整个命令名
        if (!text.includes(' ')) {
          setText('/' + suggestion.name + ' ')
        } else {
          // 参数补全：替换最后一个参数
          const parts = text.split(' ')
          parts[parts.length - 1] = suggestion.name
          setText(parts.join(' ') + ' ')
        }
        setCommandSuggestions([])
      }
      return
    }
    // 上下方向键选择建议
    if (commandSuggestions.length > 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault()
      const delta = e.key === 'ArrowDown' ? 1 : -1
      setSelectedSuggestionIdx(prev =>
        (prev + delta + commandSuggestions.length) % commandSuggestions.length
      )
      return
    }
    // Esc 关闭建议
    if (e.key === 'Escape' && commandSuggestions.length > 0) {
      e.preventDefault()
      setCommandSuggestions([])
      return
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      handleSend()
    }
    // 快捷回复快捷键：Ctrl+1..9
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key) && effectiveReplies.length > 0) {
      e.preventDefault()
      const hotkey = Number(e.key)
      const qr = effectiveReplies.find((q) => q.hotkey === hotkey)
      if (qr && !isStreaming) {
        runQuickReply(qr)
      }
    }
  }

  const handleImageSelect = async () => {
    try {
      const path = await window.api.file.selectImage()
      if (path) {
        const base64 = await window.api.file.readImageAsBase64(path)
        setImages((prev) => [...prev, base64])
      }
    } catch (err) {
      logError('ChatInput:selectImage', err)
    }
  }

  const removeImage = (index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index))
  }

  /**
   * 公共 AI 辅助调用（实现抽取至 aiInputHelper.ts；此处注入 profile/preset/请求集合）
   * @returns AI 生成的完整文本
   */
  const callAiHelper = async (opts: {
    systemPrompt: string
    userContent: string
    temperature?: number
    maxTokens?: number
    onChunk?: (delta: string, full: string) => void
  }): Promise<string> => {
    const p = getActiveProfile()
    if (!p) throw new Error('未配置 API 连接')
    const [preset] = await loadActivePresetLorebook()
    return callAiHelperCore({
      ...opts,
      profile: p,
      activeModel: settings.activeModel || p.model,
      preset,
      activeRequestIds: activeRequestIdsRef.current,
    })
  }

  /** AI 续写 */
  const handleAiContinue = async () => {
    if (isAiProcessing) return
    setIsAiProcessing(true)
    const originalInput = text
    try {
      const store = useChatStore.getState()
      const recentMessages = store.messages.slice(-6)
      const hasInput = originalInput.trim().length > 0
      const userName = settings.userName || '用户'
      const charName = getDisplayName(character)

      // 续写上下文与后处理逻辑抽取至 aiInputHelper.ts
      const contextMessages = buildContinueContext({
        character, userName, charName, recentMessages, originalInput, hasInput,
      })

      const result = await callAiHelper({
        systemPrompt: contextMessages[0].content,
        userContent: contextMessages[contextMessages.length - 1].content,
        temperature: 0.7,
        maxTokens: 300,
        onChunk: (_delta, full) => {
          setText(hasInput ? originalInput + ensureUserPerspective(full, userName, charName) : ensureUserPerspective(full, userName, charName))
        },
      })
      const cleaned = ensureUserPerspective(result, userName, charName)
      if (cleaned) {
        setText(hasInput ? originalInput + cleaned : cleaned)
      } else {
        setText(originalInput)
      }
    } catch (err) {
      logError('ChatInput:continue', err)
      setText(originalInput)
    } finally {
      setIsAiProcessing(false)
    }
  }

  /** 润色 */
  const handleAiPolish = async () => {
    if (isAiProcessing || !text.trim()) return
    setOriginalText(text)
    setIsAiProcessing(true)

    try {
      const result = await callAiHelper({
        systemPrompt: '你是一个文字润色助手。请润色以下文本，修正语法、改善表达、使其更加流畅自然，但保持原意和语气不变。只输出润色后的文本，不要添加任何解释或额外内容。',
        userContent: text,
        temperature: 0.3,
        maxTokens: 800,
        onChunk: (_delta, full) => {
          setText(full)
        },
      })
      if (!result) setText(originalText ?? '')
    } catch (err) {
      logError('ChatInput:polish', err)
      setText(originalText!)
      setOriginalText(null)
    } finally {
      setIsAiProcessing(false)
    }
  }

  return {
    text, setText, images, setImages, isAiProcessing, originalText, setOriginalText,
    commandSuggestions, setCommandSuggestions, selectedSuggestionIdx, setSelectedSuggestionIdx,
    imageMenuOpen, setImageMenuOpen, notification, textareaRef, effectiveReplies,
    isConnected, isStreaming, stopStreaming,
    runQuickReply, showNotification, buildCommandContext, handleSend, handleKeyDown,
    handleImageSelect, removeImage, handleAiContinue, handleAiPolish,
    settings,
  }
}
