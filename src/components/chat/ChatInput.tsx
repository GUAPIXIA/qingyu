import { useState, useRef, useEffect, KeyboardEvent } from 'react'
import { Send, Square, ImagePlus, X, Sparkles, Loader2, Undo2, Wand2 } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useChatStore } from '../../store/useChatStore'
import { lorebookCache } from '../../utils/lorebook'
import { useSettingsStore } from '../../store/useSettingsStore'
import { useCharacterStore } from '../../store/useCharacterStore'
import { downloadFile } from '../../utils/download'
import { getDisplayName } from '../../utils/variables'
import type { Character, Preset, Lorebook, ChatParams } from '../../../shared/types'
import { findCommand, listCommands, type CommandContext } from '../../commands/registry'
import { parseCommand } from '../../commands/parser'
import { registerBuiltinCommands } from '../../commands/builtin'

// 初始化内置命令（只执行一次）
let commandsInitialized = false
function ensureCommandsInitialized() {
  if (!commandsInitialized) {
    registerBuiltinCommands()
    commandsInitialized = true
  }
}

interface ChatInputProps {
  character: Character
  disabled?: boolean
}

/** 草稿存储 key（按角色 ID + 会话 ID 隔离） */
function draftKey(characterId: string, sessionId?: string | null) {
  return `chat-draft:${characterId}:${sessionId || 'default'}`
}

export function ChatInput({ character, disabled }: ChatInputProps) {
  // 初始化内置命令
  ensureCommandsInitialized()

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
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // H-09 修复：追踪活跃的 AI 辅助请求，组件卸载时取消
  const activeRequestIdsRef = useRef<Set<string>>(new Set())
  const { sendMessage, isStreaming, stopStreaming, activePresetId, activeLorebookIds, currentSessionId } = useChatStore()
  const { settings, getActiveProfile } = useSettingsStore()
  const { characters, selectCharacter } = useCharacterStore()

  const activeProfile = getActiveProfile()
  const isConnected = activeProfile !== null && (activeProfile.provider === 'ollama' || !!activeProfile.apiKey)

  // 显示通知（3 秒后自动消失）
  const showNotification = (msg: string) => {
    setNotification(msg)
    if (notificationTimerRef.current) clearTimeout(notificationTimerRef.current)
    notificationTimerRef.current = setTimeout(() => setNotification(null), 3000)
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
          const target = presets.find((p: any) => p.id === nameOrId || p.name === nameOrId)
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
          const target = personas.find((p: any) => p.id === nameOrId || p.name === nameOrId)
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
          const target = lorebooks.find((lb: any) => lb.id === nameOrId || lb.name === nameOrId)
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
        // 简单估算
        const total = messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0)
        const max = activeProfile?.maxContext ?? 8192
        return { total: Math.ceil(total / 4), max }  // 粗略估算 4 字符 = 1 token
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
    return () => {
      const ids = Array.from(activeRequestIdsRef.current)
      for (const id of ids) {
        window.api.ai.cancelChat(id).catch(() => {})
      }
      activeRequestIdsRef.current.clear()
    }
  }, [])

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
    await sendMessage(content, imgs, character, preset, lorebooks)
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
  }

  const handleImageSelect = async () => {
    try {
      const path = await window.api.file.selectImage()
      if (path) {
        const base64 = await window.api.file.readImageAsBase64(path)
        setImages((prev) => [...prev, base64])
      }
    } catch (err) {
      console.error('图片选择失败', err)
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
      const cleanResult = () => result.replace(/<thought>[\s\S]*?<\/thought>/gi, '').trim()
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
      console.error('续写失败', err)
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
      if (!result) setText(originalText)
    } catch (err) {
      console.error('润色失败', err)
      setText(originalText!)
      setOriginalText(null)
    } finally {
      setIsAiProcessing(false)
    }
  }

  return (
    <div className="border-t border-tavern-border-soft bg-tavern-bg-soft px-4 py-3">
      {/* 图片预览 */}
      {images.length > 0 && (
        <div className="flex gap-2 mb-2 flex-wrap">
          {images.map((img, i) => (
            <div key={i} className="relative group">
              <img src={img} alt="" className="w-20 h-20 rounded-lg object-cover border border-tavern-border" />
              <button
                onClick={() => removeImage(i)}
                className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-tavern-danger text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 回退按钮 */}
      {originalText !== null && (
        <div className="flex items-center justify-between mb-2 px-1">
          <span className="text-xs text-tavern-text-muted flex items-center gap-1">
            <Sparkles className="w-3 h-3 text-tavern-accent" />
            已润色
          </span>
          <button
            onClick={() => {
              setText(originalText)
              setOriginalText(null)
            }}
            className="flex items-center gap-1 px-2 py-1 rounded text-xs text-tavern-text-soft bg-tavern-bg-card border border-tavern-border-soft hover:border-tavern-accent hover:text-tavern-accent transition-colors"
          >
            <Undo2 className="w-3 h-3" />
            回退原文
          </button>
        </div>
      )}

      {/* 输入框 */}
      <div className="flex items-center gap-2">
        <button
          onClick={handleImageSelect}
          className="p-2 rounded-lg text-tavern-text-muted hover:text-tavern-text hover:bg-tavern-bg-hover transition-colors shrink-0"
          title="添加图片"
        >
          <ImagePlus className="w-5 h-5" />
        </button>

        <div className="relative shrink-0">
          <button
            onClick={() => setImageMenuOpen(v => !v)}
            className="p-2 rounded-lg text-tavern-text-muted hover:text-tavern-accent hover:bg-tavern-bg-hover transition-colors"
            title="AI 生图"
          >
            <Wand2 className="w-5 h-5" />
          </button>

          {imageMenuOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setImageMenuOpen(false)} />
              <div className="absolute bottom-full left-0 mb-2 w-48 rounded-lg border border-tavern-border bg-tavern-bg-soft shadow-lg z-50 overflow-hidden">
                {[
                  { label: '当前场景', desc: '自动分析对话上下文', cmd: '/imagine' },
                  { label: '角色肖像', desc: '角色全身外观', cmd: '/imagine --mode character' },
                  { label: '面部特写', desc: '角色面部细节', cmd: '/imagine --mode face' },
                  { label: '场景背景', desc: '当前场景环境', cmd: '/imagine --mode background' },
                  { label: '自定义描述...', desc: '手动输入提示词', cmd: '/imagine ' },
                ].map((item) => (
                  <button
                    key={item.label}
                    className="w-full px-3 py-2 text-left hover:bg-tavern-bg-hover transition-colors border-b border-tavern-border-soft last:border-0"
                    onClick={() => {
                      setText(item.cmd)
                      setImageMenuOpen(false)
                      setTimeout(() => textareaRef.current?.focus(), 0)
                    }}
                  >
                    <div className="text-sm text-tavern-text">{item.label}</div>
                    <div className="text-[11px] text-tavern-text-muted">{item.desc}</div>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="flex-1 relative">
          {/* 命令补全下拉 */}
          {commandSuggestions.length > 0 && (
            <div className="absolute bottom-full left-0 mb-2 max-w-md max-h-60 overflow-y-auto rounded-lg border border-tavern-border bg-tavern-bg-soft shadow-lg z-50">
              {commandSuggestions.map((s, i) => (
                <button
                  key={s.name}
                  className={cn(
                    'w-full px-3 py-2 text-left text-sm hover:bg-tavern-bg-hover flex items-center gap-2',
                    i === selectedSuggestionIdx && 'bg-tavern-bg-hover'
                  )}
                  onClick={() => {
                    if (!text.includes(' ')) {
                      setText('/' + s.name + ' ')
                    } else {
                      const parts = text.split(' ')
                      parts[parts.length - 1] = s.name
                      setText(parts.join(' ') + ' ')
                    }
                    setCommandSuggestions([])
                    textareaRef.current?.focus()
                  }}
                >
                  <span className="font-mono text-tavern-accent">
                    {text.includes(' ') ? s.name : '/' + s.name}
                  </span>
                  {s.description && (
                    <span className="text-xs text-tavern-text-muted truncate">{s.description}</span>
                  )}
                </button>
              ))}
              <div className="px-3 py-1 text-[10px] text-tavern-text-muted border-t border-tavern-border-soft">
                Tab 补全 · ↑↓ 选择 · Esc 关闭
              </div>
            </div>
          )}
          {/* 通知提示 */}
          {notification && (
            <div className="absolute bottom-full left-0 mb-2 px-3 py-1.5 rounded-lg bg-tavern-accent text-white text-xs shadow-lg z-50 animate-fade-in">
              {notification}
            </div>
          )}
          <textarea
            ref={textareaRef}
            autoFocus
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              if (originalText !== null && e.target.value !== originalText) {
                setOriginalText(null)
              }
            }}
            onKeyDown={handleKeyDown}
            placeholder={
              !isConnected
                ? '请先在设置中配置 API 连接...'
                : isStreaming
                ? '正在生成回复...'
                : '输入消息，Enter 发送，Shift+Enter 换行'
            }
            disabled={disabled || isStreaming}
            rows={1}
            className="textarea w-full resize-none py-2.5 pr-3 leading-relaxed"
            style={{ minHeight: '42px', maxHeight: '200px' }}
          />
        </div>

        {/* AI 辅助按钮 */}
        {!isStreaming && (
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={handleAiContinue}
              disabled={isAiProcessing}
              className={cn(
                'px-2.5 py-1.5 rounded-lg text-xs border transition-colors flex items-center gap-1',
                isAiProcessing
                  ? 'border-tavern-border-soft bg-tavern-bg-card text-tavern-text-muted cursor-not-allowed'
                  : 'border-tavern-border-soft bg-tavern-bg-card text-tavern-text-soft hover:text-tavern-accent hover:border-tavern-accent'
              )}
              title="AI 根据上下文续写输入文字"
            >
              {isAiProcessing ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <Sparkles className="w-3 h-3" />
              )}
              续写
            </button>
            {text.trim().length > 0 && (
              <button
                onClick={handleAiPolish}
                disabled={isAiProcessing}
                className={cn(
                  'px-2.5 py-1.5 rounded-lg text-xs border transition-colors flex items-center gap-1',
                  isAiProcessing
                    ? 'border-tavern-border-soft bg-tavern-bg-card text-tavern-text-muted cursor-not-allowed'
                    : 'border-tavern-border-soft bg-tavern-bg-card text-tavern-text-soft hover:text-tavern-accent hover:border-tavern-accent'
                )}
                title="AI 润色输入文字"
              >
                {isAiProcessing ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <Sparkles className="w-3 h-3" />
                )}
                润色
              </button>
            )}
          </div>
        )}

        {isStreaming ? (
          <button
            onClick={stopStreaming}
            className="p-2.5 rounded-lg bg-tavern-danger text-white hover:opacity-90 transition-opacity shrink-0"
            title="停止生成"
          >
            <Square className="w-5 h-5" fill="currentColor" />
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={!text.trim() || !isConnected}
            className={cn(
              'p-2.5 rounded-lg transition-all shrink-0',
              text.trim() && isConnected
                ? 'btn-primary'
                : 'bg-tavern-bg-card text-tavern-text-muted cursor-not-allowed'
            )}
            title="发送"
          >
            <Send className="w-5 h-5" />
          </button>
        )}
      </div>
    </div>
  )
}
