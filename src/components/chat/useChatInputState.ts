import { useState, useRef, useEffect } from 'react'
import type { KeyboardEvent } from 'react'
import { useChatStore } from '../../store/useChatStore'
import { lorebookCache } from '../../utils/lorebook'
import { useSettingsStore } from '../../store/useSettingsStore'
import { useCharacterStore } from '../../store/useCharacterStore'
import { downloadFile } from '../../utils/download'
import { logError } from '../../lib/logger'
import { isLocalProvider, isLocalUrl } from '../../utils/defaults'
import { getDisplayName } from '../../utils/variables'
import { expandMacros, buildMacroContext } from '../../utils/macros'
import { getEffectiveQuickReplies } from '../../utils/quickReply'
import type { Character, Preset, Lorebook, ChatParams, QuickReply, QuickReplyStore, Message } from '../../../shared/types'
import { findCommand, listCommands, type CommandContext } from '../../commands/registry'
import { parseCommand } from '../../commands/parser'
import { registerBuiltinCommands } from '../../commands/builtin'
import { stripThought } from '../../utils/messagePostProcess'

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

  const { currentSessionId } = useChatStore()
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
  const { sendMessage, isStreaming, stopStreaming, activePresetId, activeLorebookIds } = useChatStore()
  const { settings, getActiveProfile } = useSettingsStore()
  const { characters, selectCharacter } = useCharacterStore()

  const activeProfile = getActiveProfile()
  const isConnected = activeProfile !== null && (isLocalProvider(activeProfile.provider) || isLocalUrl(activeProfile.baseUrl) || !!activeProfile.apiKey)

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

  /** 加载当前选中的预设和所有激活的世界书（同时更新缓存） */
  const loadActivePresetLorebook = async (): Promise<[Preset | null, Lorebook[]]> => {
    let preset: Preset | null = null
    if (activePresetId) {
      const presets = await window.api.preset.list()
      preset = presets.find(p => p.id === activePresetId) ?? null
    }
    let lorebooks: Lorebook[] = []
    if (activeLorebookIds.length > 0) {
      lorebooks = (await lorebookCache.refresh(activeLorebookIds)).filter(lb => lb.enabled)
    } else {
      lorebookCache.clear()
    }
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
        charName: character.name,
        originalCharName: character.translatedContent?.name,
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

  // 构建命令上下文
  const buildCommandContext = (): CommandContext => {
    const chatStore = useChatStore.getState()
    return {
      character,
      sendMessage: async (content, imgs) => {
        const [preset, lorebooks] = await loadActivePresetLorebook()
        await chatStore.sendMessage(content, imgs, character, preset, lorebooks)
      },
      addImageMessage: async (imgs, content) => {
        await chatStore.addStandaloneMessage(content ?? '', imgs, character, 'system')
      },
      clearChat: async () => {
        await chatStore.clearChat(character.id)
      },
      regenerateLastMessage: async () => {
        const messages = chatStore.messages
        const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant')
        if (!lastAssistant) {
          showNotification('没有可重新生成的 AI 回复')
          return
        }
        const [preset, lorebooks] = await loadActivePresetLorebook()
        await chatStore.regenerateMessage(lastAssistant.id, character, preset, lorebooks)
      },
      continueLastMessage: async () => {
        const messages = chatStore.messages
        const lastMsg = messages[messages.length - 1]
        // continueMessage 要求目标是最后一条消息且为 assistant
        if (!lastMsg || lastMsg.role !== 'assistant') {
          showNotification('最后一条消息不是 AI 回复，无法续写')
          return
        }
        const [preset, lorebooks] = await loadActivePresetLorebook()
        await chatStore.continueMessage(lastMsg.id, character, preset, lorebooks)
      },
      triggerMemorySummary: async () => {
        const result = await chatStore.triggerMemorySummary(character)
        if (result) showNotification('长记忆总结已完成')
        else showNotification('长记忆总结失败或消息太少')
      },
      exportChat: async (format) => {
        const sid = chatStore.currentSessionId
        if (!sid) return
        const content = await window.api.chat.exportChat(character.id, sid, format)
        const mimeType = format === 'json' ? 'application/json' : 'text/markdown'
        const ext = format === 'json' ? 'json' : 'md'
        downloadFile(content, `${character.name}-对话.${ext}`, mimeType)
        showNotification(`已导出为 ${format.toUpperCase()} 格式`)
      },
      swipeMessage: async (direction) => {
        const messages = chatStore.messages
        const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant')
        if (!lastAssistant) {
          showNotification('没有可切换的 AI 回复')
          return
        }
        await chatStore.swipeMessage(lastAssistant.id, direction, character)
      },
      notify: showNotification,
      switchCharacter: async (nameOrId) => {
        const target = characters.find(c => c.id === nameOrId || c.name === nameOrId)
        if (target) {
          selectCharacter(target.id)
          showNotification(`已切换到角色: ${target.name}`)
          return true
        }
        showNotification(`未找到角色: ${nameOrId}`)
        return false
      },
      switchPreset: async (nameOrId) => {
        try {
          const presets = await window.api.preset.list()
          const target = presets.find((p) => p.id === nameOrId || p.name === nameOrId)
          if (target) {
            chatStore.setActivePreset(target.id, character.id)
            showNotification(`已切换到预设: ${target.name}`)
            return true
          }
        } catch { /* ignore */ }
        showNotification(`未找到预设: ${nameOrId}`)
        return false
      },
      switchPersona: async (nameOrId) => {
        try {
          const personas = await window.api.persona.list()
          const target = personas.find((p) => p.id === nameOrId || p.name === nameOrId)
          if (target) {
            // 同步 persona 到 settings（与 ChatHeader.handleSwitchPersona 保持一致）
            useSettingsStore.getState().updateSettings({
              activePersonaId: target.id,
              userName: target.name,
              userDescription: target.description,
              userPersona: target.persona,
            })
            // 保存到当前会话
            if (chatStore.currentSessionId) {
              await window.api.chat.updateSession(character.id, chatStore.currentSessionId, { personaId: target.id })
              useChatStore.setState(s => ({
                sessions: s.sessions.map(sess =>
                  sess.id === chatStore.currentSessionId ? { ...sess, personaId: target.id } : sess
                ),
              }))
            }
            showNotification(`已切换到人设: ${target.name}`)
            return true
          }
        } catch { /* ignore */ }
        showNotification(`未找到人设: ${nameOrId}`)
        return false
      },
      toggleLorebook: async (nameOrId) => {
        try {
          const lorebooks = await window.api.lorebook.list()
          const target = lorebooks.find((lb) => lb.id === nameOrId || lb.name === nameOrId)
          if (target) {
            const curIds = chatStore.activeLorebookIds
            if (curIds.includes(target.id)) {
              chatStore.setActiveLorebooks(curIds.filter(id => id !== target.id), character.id)
              showNotification(`已关闭世界书: ${target.name}`)
            } else {
              chatStore.setActiveLorebooks([...curIds, target.id], character.id)
              showNotification(`已激活世界书: ${target.name}`)
            }
            return true
          }
        } catch { /* ignore */ }
        showNotification(`未找到世界书: ${nameOrId}`)
        return false
      },
      getTokenUsage: () => {
        const messages = chatStore.messages
        const total = messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0)
        return { total, max: 0 }
      },
      callAiHelper: async (systemPrompt, userContent, options) => {
        return callAiHelper({
          systemPrompt,
          userContent,
          temperature: options?.temperature,
          maxTokens: options?.maxTokens,
        })
      },
      getRecentMessages: (count) => {
        return chatStore.messages
          .filter(m => m.content && m.content.trim())
          .slice(-count)
          .map(m => ({
            role: m.role as 'user' | 'assistant',
            content: m.content,
            name: m.role === 'user' ? (settings.userName || '用户') : character.name,
          }))
      },
      userName: settings.userName || '用户',
    }
  }

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
    if (e.key === 'Enter' && !e.shiftKey) {
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
   * 抽取的公共 AI 辅助调用方法（修复 handleAiContinue / handleAiPolish 重复代码）
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
    let result = ''
    const requestId = `ai-helper-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    activeRequestIdsRef.current.add(requestId)

    return new Promise<string>((resolve, reject) => {
      const cleanup = () => {
        activeRequestIdsRef.current.delete(requestId)
        unbindChunk(); unbindDone(); unbindError()
      }
      const cleanResult = () => stripThought(result)
      const unbindChunk = window.api.ai.onChunk((data) => {
        if (data.requestId !== requestId) return
        result += data.text
        opts.onChunk?.(data.text, cleanResult())
      })
      const unbindDone = window.api.ai.onDone((doneId) => {
        if (doneId !== requestId) return
        cleanup()
        resolve(cleanResult())
      })
      const unbindError = window.api.ai.onError((data) => {
        if (data.requestId !== requestId) return
        cleanup()
        reject(new Error(data.error))
      })

      const params: ChatParams = {
        requestId,
        messages: [
          { role: 'system', content: opts.systemPrompt },
          { role: 'user', content: opts.userContent },
        ],
        provider: p.provider,
        apiKey: p.apiKey,
        baseUrl: p.baseUrl,
        model: settings.activeModel || p.model,
        temperature: opts.temperature ?? preset?.temperature ?? 0.5,
        topP: preset?.topP ?? 0.9,
        maxTokens: opts.maxTokens ?? 800,
        frequencyPenalty: preset?.frequencyPenalty ?? 0,
        presencePenalty: preset?.presencePenalty ?? 0,
        stream: false,
      }

      window.api.ai.chat(params).catch((err) => {
        cleanup()
        reject(err)
      })
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

      // 后处理：确保输出是用户视角，剥离角色视角内容
      const ensureUserPerspective = (raw: string): string => {
        let output = raw.trim()
        // 如果输出以角色名开头（含冒号），说明 AI 以角色身份回复了，剥离角色部分
        const charPrefix = new RegExp(`^\\*?${charName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[:：]\\s*`, 'i')
        if (charPrefix.test(output)) {
          // 找到用户发言部分（如果有的话）
          const userLine = new RegExp(`(?:^|\\n)\\*?${userName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[:：]\\s*(.*)`, 'i')
          const match = output.match(userLine)
          if (match) {
            output = match[1].trim()
          } else {
            // 没有用户部分，丢弃全部（AI 以角色视角回复了）
            return ''
          }
        }
        return output
      }

      const systemPrompt = hasInput
        ? `你是一个角色扮演对话的用户视角续写助手。你的任务是以【用户 ${userName}】的身份和口吻，续写用户未完成的消息。\n\n严格要求：\n- 只输出 ${userName} 的话语，绝对不要输出 ${charName} 的话语\n- 不要以 ${charName} 的身份说话或行动\n- 不要包含角色名前缀，直接输出对话内容\n- 保持用户一贯的语气和风格`
        : `你是一个角色扮演对话的用户视角续写助手。你的任务是以【用户 ${userName}】的身份和口吻，生成一条合适的用户回复。\n\n严格要求：\n- 只输出 ${userName} 的话语，绝对不要输出 ${charName} 的话语\n- 不要以 ${charName} 的身份说话或行动\n- 不要包含角色名前缀，直接输出对话内容\n- 保持用户一贯的语气和风格`

      const contextMessages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
        { role: 'system', content: `${systemPrompt}\n\n当前角色：${charName}\n角色设定：${character.description || '无'}\n场景：${character.scenario || '无'}` },
      ]
      for (const msg of recentMessages) {
        contextMessages.push({
          role: msg.role === 'user' ? 'user' : 'assistant',
          content: msg.content,
        })
      }
      contextMessages.push({
        role: 'user',
        content: hasInput ? `请以 ${userName} 的身份续写以下未完成的消息（直接接在后面的部分）：\n${originalInput}` : `请以 ${userName} 的身份根据上下文生成一条回复`,
      })

      const result = await callAiHelper({
        systemPrompt: contextMessages[0].content,
        userContent: contextMessages[contextMessages.length - 1].content,
        temperature: 0.7,
        maxTokens: 300,
        onChunk: (_delta, full) => {
          setText(hasInput ? originalInput + ensureUserPerspective(full) : ensureUserPerspective(full))
        },
      })
      const cleaned = ensureUserPerspective(result)
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
