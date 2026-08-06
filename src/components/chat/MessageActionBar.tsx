import React, { useState, useRef, useEffect } from 'react'
import { Edit2, Copy, Reply, RotateCcw, Trash2, Volume2, VolumeX, Play, Pause, Languages, GitBranch, RefreshCw, Loader2 } from 'lucide-react'
import type { Message, Character } from '../../../shared/types'
import { useChatStore } from '../../store/useChatStore'
import { useSettingsStore } from '../../store/useSettingsStore'
import { cn } from '../../lib/utils'
import { stripThought, stripThoughtTags } from '../../utils/messagePostProcess'

/**
 * 消息操作栏（MessageBubble 提取，2026-08-06）：
 * 纯图 system / 用户 / AI 三处操作栏收敛为单一组件，TTS 播放、翻译切换、分支、
 * 重新生图、AI 重新生成（preset/lorebook 上下文）等逻辑自治于此。
 */
export interface MessageActionBarProps {
  message: Message
  character: Character | null
  isUser: boolean
  isSystem: boolean
  isStreaming: boolean
  /** 纯图片 system 消息（生图结果）独立居中布局：编辑/复制/引用回复/重新生图/删除 */
  bare?: boolean
  /** 引用回复回调（可选） */
  onReply?: () => void
  /** 进入编辑模式 */
  onEdit: () => void
}

export const MessageActionBar = React.memo(function MessageActionBar({
  message, character, isUser, isSystem, isStreaming, bare, onReply, onEdit,
}: MessageActionBarProps) {
  const deleteMessage = useChatStore((s) => s.deleteMessage)
  const regenerateMessage = useChatStore((s) => s.regenerateMessage)
  const translateMessage = useChatStore((s) => s.translateMessage)
  const updateMessageImages = useChatStore((s) => s.updateMessageImages)
  const translatingMessages = useChatStore((s) => s.translatingMessages)
  const showTranslationIds = useChatStore((s) => s.showTranslationIds)
  const { settings, getActiveTTS } = useSettingsStore()

  const [ttsState, setTtsState] = useState<'idle' | 'speaking' | 'paused'>('idle')
  const [regenerating, setRegenerating] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const ttsConfig = getActiveTTS()
  const transState = translatingMessages[message.id]
  const showTranslation = showTranslationIds.has(message.id)
  const isTranslating = transState?.status === 'translating'

  // 系统语音完成事件：订阅主进程推送，播放结束自动复位（openai/edge 由 audio onended 处理）
  useEffect(() => {
    if (ttsConfig?.provider !== 'system') return
    const unsubscribe = window.api.tts.onState((state) => {
      if (state === 'idle') setTtsState('idle')
    })
    return unsubscribe
  }, [ttsConfig?.provider])

  const handleCopy = async () => {
    // BUG-31 修复：处理 clipboard 写入失败（权限/焦点丢失等），避免静默失败
    try {
      await navigator.clipboard.writeText(message.content)
    } catch {
      // 回退方案：隐藏 textarea + execCommand
      try {
        const ta = document.createElement('textarea')
        ta.value = message.content
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      } catch {
        useChatStore.setState({ error: '复制失败：无法访问剪贴板' })
      }
    }
  }

  const handleSpeak = async () => {
    if (!message.content) return
    // TTS 朗读前预处理：默认剥离内心想法（<thought> 块）；开启"朗读内心想法"时仅去掉标签、保留内容
    const speakText = settings.ttsReadThought
      ? stripThoughtTags(message.content)
      : stripThought(message.content)
    if (!speakText.trim()) return
    if (!ttsConfig) return    // OpenAI / Edge TTS：渲染进程直接控制音频播放（主进程返回 mp3 base64）
    try {
      if (ttsConfig.provider === 'openai' || ttsConfig.provider === 'edge') {
        if (ttsState === 'speaking') {
          audioRef.current?.pause()
          setTtsState('paused')
          return
        }
        if (ttsState === 'paused') {
          await audioRef.current?.play()
          setTtsState('speaking')
          return
        }
        const res = await window.api.tts.speak(
          speakText,
          ttsConfig.provider === 'edge'
            ? {
                provider: 'edge',
                voice: ttsConfig.voice || 'zh-CN-XiaoxiaoNeural',
                rate: 1,
                // 代理按 TTS 配置（留空直连；代理失败主进程自动回退直连）
                proxy: ttsConfig.proxy || undefined,
              }
            : {
                provider: 'openai',
                voice: ttsConfig.voice || 'alloy',
                rate: 1,
                model: ttsConfig.model,
                apiKey: ttsConfig.apiKey,
                baseUrl: ttsConfig.baseUrl,
              },
        )
        if (res.success && res.audioBase64) {
          const audio = new Audio(`data:audio/mp3;base64,${res.audioBase64}`)
          audio.onended = () => setTtsState('idle')
          audio.onerror = () => setTtsState('idle')
          audioRef.current = audio
          setTtsState('speaking')
          await audio.play().catch(() => setTtsState('idle'))
        } else {
          setTtsState('idle')
        }
        return
      }

      if (ttsState === 'speaking') {
        await window.api.tts.pause()
        setTtsState('paused')
      } else if (ttsState === 'paused') {
        await window.api.tts.resume()
        setTtsState('speaking')
      } else {
        await window.api.tts.speak(speakText, {
          provider: ttsConfig.provider,
          voice: ttsConfig.voice,
          rate: 1,
        })
        setTtsState('speaking')
      }
    } catch (err) {
      // 审查报告 P2：TTS IPC 失败时复位状态，避免按钮卡死 + 未处理拒绝
      setTtsState('idle')
      useChatStore.setState({ error: `朗读失败: ${err instanceof Error ? err.message : String(err)}` })
    }
  }

  const handleStopSpeak = async () => {
    audioRef.current?.pause()
    audioRef.current = null
    try {
      await window.api.tts.stop()
    } catch {
      // 审查报告 P3：停止失败不阻断状态复位
    }
    setTtsState('idle')
  }

  const handleTranslate = () => {
    if (!message.content || isTranslating) return
    // 如果已有翻译结果，切换显示
    if (transState?.status === 'done') {
      // 无论当前是否显示翻译，切换显示状态
      useChatStore.getState().toggleTranslation(message.id)
      return
    }
    // 发起翻译
    translateMessage(message.id, message.content)
    // 翻译开始后自动显示
    useChatStore.getState().toggleTranslation(message.id)
  }

  const handleBranch = async () => {
    if (!character) return
    try {
      // 创建新会话作为分支
      const branchSession = await window.api.chat.createSession(character.id, `分支: ${message.content.slice(0, 20)}...`)
      if (!branchSession) return
      const { messages } = useChatStore.getState()
      const branchIdx = messages.findIndex((m) => m.id === message.id)
      if (branchIdx < 0) return
      const branchMsgs = messages.slice(0, branchIdx + 1)
      for (const msg of branchMsgs) {
        const branchMsg = { ...msg, id: `${msg.id}_b`, sessionId: branchSession.id, characterId: character.id }
        await window.api.chat.saveMessage(branchMsg)
      }
      // 刷新会话列表
      const sessions = await window.api.chat.listSessions(character.id)
      useChatStore.setState({ sessions, currentSessionId: branchSession.id })
      // 切换到新分支
      const branchMessages = await window.api.chat.listMessages(character.id, branchSession.id)
      useChatStore.setState({ messages: branchMessages })
    } catch (err) {
      // 审查报告 P1：IPC 失败时提示用户，避免未处理拒绝与状态脱节
      useChatStore.setState({ error: `创建分支失败: ${err instanceof Error ? err.message : String(err)}` })
    }
  }

  /** AI 消息重新生成：加载 preset/lorebook 上下文后重跑 */
  const handleRegenerate = async () => {
    if (!character) return
    const chatStore = useChatStore.getState()
    let preset: import('../../../shared/types').Preset | null = null
    if (chatStore.activePresetId) {
      const presets = await window.api.preset.list()
      preset = presets.find((p) => p.id === chatStore.activePresetId) ?? null
    }
    const activeLorebooks: import('../../../shared/types').Lorebook[] = []
    if (chatStore.activeLorebookIds.length > 0) {
      const lorebooks = await window.api.lorebook.list()
      for (const id of chatStore.activeLorebookIds) {
        const lb = lorebooks.find((lb) => lb.id === id)
        if (lb && lb.enabled) activeLorebooks.push(lb)
      }
    }
    await regenerateMessage(message.id, character, preset, activeLorebooks).catch((e) => {
      // 与续写按钮一致：IPC/加载失败时提示而非静默
      useChatStore.setState({ error: `重新生成失败: ${e instanceof Error ? e.message : String(e)}` })
    })
  }

  /** 重新生图（生图消息） */
  const handleRegenerateImage = async () => {
    setRegenerating(true)
    try {
      const result = await window.api.imageGen.generate(message.content)
      if (result.success && result.images?.length) {
        await updateMessageImages(message.id, result.images)
      }
    } catch { /* 忽略 */ }
    setRegenerating(false)
  }

  const iconBtn = 'p-1.5 rounded text-tavern-text-muted hover:text-tavern-text hover:bg-tavern-bg-hover transition-colors'

  if (isStreaming) return null

  // 纯图片 system 消息（生图结果）：独立居中布局
  if (bare) {
    return (
      <div className="flex items-center justify-center gap-1 mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button className={iconBtn} onClick={onEdit} title="编辑"><Edit2 className="w-3.5 h-3.5" /></button>
        <button className={iconBtn} onClick={handleCopy} title="复制"><Copy className="w-3.5 h-3.5" /></button>
        {onReply && (
          <button className="p-1.5 rounded text-tavern-text-muted hover:text-tavern-accent hover:bg-tavern-bg-hover transition-colors" onClick={onReply} title="引用回复"><Reply className="w-3.5 h-3.5" /></button>
        )}
        <button className="p-1.5 rounded text-tavern-text-muted hover:text-tavern-accent hover:bg-tavern-bg-hover transition-colors disabled:opacity-50" disabled={regenerating} onClick={handleRegenerateImage} title="重新生图">
          {regenerating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
        </button>
        <button className="p-1.5 rounded text-tavern-text-muted hover:text-tavern-danger hover:bg-tavern-bg-hover transition-colors" onClick={() => character && deleteMessage(message.id, character)} title="删除"><Trash2 className="w-3.5 h-3.5" /></button>
      </div>
    )
  }

  // 用户消息
  if (isUser) {
    return (
      <div className={cn('flex items-center gap-1 mt-1 opacity-0 group-hover:opacity-100 transition-opacity flex-row-reverse')}>
        <button className={iconBtn} onClick={onEdit} title="编辑"><Edit2 className="w-3.5 h-3.5" /></button>
        <button className={iconBtn} onClick={handleCopy} title="复制"><Copy className="w-3.5 h-3.5" /></button>
        <button
          className={iconBtn}
          onClick={handleBranch}
          title="从此处分支"
        >
          <GitBranch className="w-3.5 h-3.5" />
        </button>
        <button
          className="p-1.5 rounded text-tavern-text-muted hover:text-tavern-danger hover:bg-tavern-bg-hover transition-colors"
          onClick={() => character && deleteMessage(message.id, character)}
          title="删除"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    )
  }

  // AI / 系统消息
  return (
    <div className="flex items-center gap-1 mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
      <button className={iconBtn} onClick={onEdit} title="编辑"><Edit2 className="w-3.5 h-3.5" /></button>
      <button className={iconBtn} onClick={handleCopy} title="复制"><Copy className="w-3.5 h-3.5" /></button>
      {!isSystem && character && (
        <button
          className={iconBtn}
          onClick={handleRegenerate}
          title="重新生成"
          disabled={isStreaming}
        >
          <RotateCcw className="w-3.5 h-3.5" />
        </button>
      )}
      {!isSystem && (
        <>
          <button
            className={cn(
              'p-1.5 rounded transition-colors',
              ttsState !== 'idle'
                ? 'text-tavern-accent bg-tavern-accent-soft'
                : 'text-tavern-text-muted hover:text-tavern-text hover:bg-tavern-bg-hover'
            )}
            onClick={handleSpeak}
            title={ttsState === 'speaking' ? '暂停' : ttsState === 'paused' ? '继续' : '朗读'}
          >
            {ttsState === 'speaking' ? <Pause className="w-3.5 h-3.5" /> : ttsState === 'paused' ? <Play className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
          </button>
          {ttsState !== 'idle' && (
            <button
              className="p-1.5 rounded text-tavern-text-muted hover:text-tavern-danger hover:bg-tavern-bg-hover transition-colors"
              onClick={handleStopSpeak}
              title="停止朗读"
            >
              <VolumeX className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            className={cn(
              'p-1.5 rounded transition-colors',
              showTranslation ? 'text-tavern-accent bg-tavern-accent-soft' : (isTranslating ? 'text-tavern-accent animate-pulse' : 'text-tavern-text-muted hover:text-tavern-text hover:bg-tavern-bg-hover')
            )}
            onClick={handleTranslate}
            title={showTranslation ? '切回原文' : isTranslating ? '翻译中...' : '翻译'}
            disabled={isTranslating}
          >
            <Languages className="w-3.5 h-3.5" />
          </button>
        </>
      )}
      <button
        className={iconBtn}
        onClick={handleBranch}
        title="从此处分支"
      >
        <GitBranch className="w-3.5 h-3.5" />
      </button>
      {/* 重新生图（仅 system 生图消息） */}
      {isSystem && message.content && (
        <button
          className="p-1.5 rounded text-tavern-text-muted hover:text-tavern-accent hover:bg-tavern-bg-hover transition-colors disabled:opacity-50"
          disabled={regenerating}
          onClick={handleRegenerateImage}
          title="重新生图"
        >
          {regenerating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
        </button>
      )}
      <button
        className="p-1.5 rounded text-tavern-text-muted hover:text-tavern-danger hover:bg-tavern-bg-hover transition-colors"
        onClick={() => character && deleteMessage(message.id, character)}
        title="删除"
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    </div>
  )
})
