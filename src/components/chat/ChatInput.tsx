import { useState, useRef, useEffect, KeyboardEvent } from 'react'
import { Send, Square, ImagePlus, X, Sparkles, Loader2, Undo2 } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useChatStore } from '../../store/useChatStore'
import { useSettingsStore } from '../../store/useSettingsStore'
import type { Character } from '../../../shared/types'

interface ChatInputProps {
  character: Character
  disabled?: boolean
}

export function ChatInput({ character, disabled }: ChatInputProps) {
  const [text, setText] = useState('')
  const [images, setImages] = useState<string[]>([])
  const [isAiProcessing, setIsAiProcessing] = useState(false)
  const [originalText, setOriginalText] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const { sendMessage, isStreaming, stopStreaming } = useChatStore()
  const { settings, getActiveProfile } = useSettingsStore()

  const activeProfile = getActiveProfile()
  const isConnected = activeProfile !== null && (activeProfile.provider === 'ollama' || !!activeProfile.apiKey)

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + 'px'
    }
  }, [text])

  const handleSend = async () => {
    if (!text.trim() || isStreaming) return
    const content = text.trim()
    const imgs = [...images]
    setText('')
    setImages([])
    setOriginalText(null)
    await sendMessage(content, imgs, character, null, null)
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleImageSelect = async () => {
    const path = await window.api.file.selectImage()
    if (path) {
      const base64 = await window.api.file.readImageAsBase64(path)
      setImages((prev) => [...prev, base64])
    }
  }

  const removeImage = (index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index))
  }

  /** AI 续写 */
  const handleAiContinue = async () => {
    if (isAiProcessing) return
    const p = getActiveProfile()
    if (!p) return
    setIsAiProcessing(true)
    const originalInput = text
    try {
      const store = useChatStore.getState()
      const recentMessages = store.messages.slice(-6)
      const hasInput = originalInput.trim().length > 0

      const systemPrompt = hasInput
        ? `你是一个角色扮演对话续写助手。请根据对话上下文，以用户的身份和口吻，续写用户未完成的消息。只需要输出续写部分，不要添加任何解释。直接接在用户已有内容后面，保持语气和风格一致。`
        : `你是一个角色扮演对话续写助手。请根据对话上下文，以用户的身份和口吻，生成一条合适的用户回复。只需要输出生成的内容，不要添加任何解释或标签。`

      const contextMessages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
        { role: 'system', content: `${systemPrompt}\n\n当前角色：${character.name}\n角色设定：${character.description || '无'}\n场景：${character.scenario || '无'}` },
      ]

      for (const msg of recentMessages) {
        contextMessages.push({
          role: msg.role === 'user' ? 'user' : 'assistant',
          content: msg.content,
        })
      }

      contextMessages.push({
        role: 'user',
        content: hasInput ? `请续写以下未完成的消息（直接接在后面的部分）：\n${originalInput}` : '请根据上下文生成我应该说的话',
      })

      let result = ''
      const requestId = `ai-continue-${Date.now()}`

      const unbindChunk = window.api.ai.onChunk((data) => {
        if (data.requestId !== requestId) return
        result += data.text
        setText(hasInput ? originalInput + result : result)
      })

      const unbindDone = window.api.ai.onDone((doneId) => {
        if (doneId !== requestId) return
        unbindChunk(); unbindDone(); unbindError()
        if (!result) setText(originalInput)
        setIsAiProcessing(false)
      })

      const unbindError = window.api.ai.onError(() => {
        unbindChunk(); unbindDone(); unbindError()
        setIsAiProcessing(false)
      })

      await window.api.ai.chat({
        requestId,
        messages: contextMessages,
        provider: p.provider,
        apiKey: p.apiKey,
        baseUrl: p.baseUrl,
        model: settings.activeModel || p.model,
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 300,
        frequencyPenalty: 0,
        presencePenalty: 0,
        stream: false,
      })
    } catch {
      setIsAiProcessing(false)
    }
  }

  /** 润色 */
  const handleAiPolish = async () => {
    if (isAiProcessing || !text.trim()) return
    const p = getActiveProfile()
    if (!p) return
    setOriginalText(text)
    setIsAiProcessing(true)

    try {
      let result = ''
      const requestId = `ai-polish-${Date.now()}`

      const unbindChunk = window.api.ai.onChunk((data) => {
        if (data.requestId !== requestId) return
        result += data.text
        setText(result)
      })

      const unbindDone = window.api.ai.onDone((doneId) => {
        if (doneId !== requestId) return
        unbindChunk(); unbindDone(); unbindError()
        if (!result) setText(originalText)
        setIsAiProcessing(false)
      })

      const unbindError = window.api.ai.onError(() => {
        unbindChunk(); unbindDone(); unbindError()
        setText(originalText!)
        setOriginalText(null)
        setIsAiProcessing(false)
      })

      await window.api.ai.chat({
        requestId,
        messages: [
          {
            role: 'system',
            content: '你是一个文字润色助手。请润色以下文本，修正语法、改善表达、使其更加流畅自然，但保持原意和语气不变。只输出润色后的文本，不要添加任何解释或额外内容。',
          },
          { role: 'user', content: text },
        ],
        provider: p.provider,
        apiKey: p.apiKey,
        baseUrl: p.baseUrl,
        model: settings.activeModel || p.model,
        temperature: 0.3,
        topP: 0.9,
        maxTokens: 800,
        frequencyPenalty: 0,
        presencePenalty: 0,
        stream: false,
      })
    } catch {
      setText(originalText!)
      setOriginalText(null)
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
      <div className="flex items-end gap-2">
        <button
          onClick={handleImageSelect}
          className="p-2 rounded-lg text-tavern-text-muted hover:text-tavern-text hover:bg-tavern-bg-hover transition-colors shrink-0"
          title="添加图片"
        >
          <ImagePlus className="w-5 h-5" />
        </button>

        <div className="flex-1 relative">
          <textarea
            ref={textareaRef}
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
