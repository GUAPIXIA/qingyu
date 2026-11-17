import React, { useState, useRef, useEffect } from 'react'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { Edit2, Copy, Reply, RotateCcw, Trash2, VolumeX, Languages, GitBranch, RefreshCw, Loader2 } from 'lucide-react'
import { Pause, Play, Volume2 } from 'lucide'
import { MorphingIcon } from '../common/MorphingIcon'
import type { Message, Character } from '../../../shared/types'
import { useChatStore } from '../../store/useChatStore'
import { useSettingsStore } from '../../store/useSettingsStore'
import { pushToast } from '../../store/useToastStore'
import { cn } from '../../lib/utils'
import { splitTtsChunks } from '../../lib/ttsChunks'
import { sanitizeTtsText } from '../../lib/ttsText'
import { stripThought, stripThoughtTags } from '../../../shared/chat-core/messagePostProcess'

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
  /**
   * 气泡当前显示的译文（与 MessageBubble 的 displayContent 同口径，含语言/来源校验与内存回退）。
   * 显示译文时朗读译文；为空表示显示原文或尚无可用译文，朗读原文。
   */
  translatedText?: string | null
}

export const MessageActionBar = React.memo(function MessageActionBar({
  message, character, isUser, isSystem, isStreaming, bare, onReply, onEdit, translatedText,
}: MessageActionBarProps) {
  const deleteMessage = useChatStore((s) => s.deleteMessage)
  const regenerateMessage = useChatStore((s) => s.regenerateMessage)
  const translateMessage = useChatStore((s) => s.translateMessage)
  const updateMessageImages = useChatStore((s) => s.updateMessageImages)
  const translatingMessages = useChatStore((s) => s.translatingMessages)
  const showTranslationIds = useChatStore((s) => s.showTranslationIds)
  // P-6 修复：字段级选择器订阅
  const settings = useSettingsStore((s) => s.settings)
  const getActiveTTS = useSettingsStore((s) => s.getActiveTTS)

  const [ttsState, setTtsState] = useState<'idle' | 'speaking' | 'paused'>('idle')
  const [regenerating, setRegenerating] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  /** DeepSeek 分句朗读队列控制（wav 单段体积可控，逐句合成首句更快出声） */
  const deepseekCtlRef = useRef<{
    cancelled: boolean
    paused: boolean
    resumeWaiters: Array<() => void>
    finish: (() => void) | null
  } | null>(null)

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

  /**
   * DeepSeek 分句朗读：逐句请求合成、顺序播放。
   *
   * 不用整段一次合成的原因：DeepSeek 返回未压缩 wav（24 kHz 16-bit 单声道约 48 KB/s），
   * 长回复整段合成首包慢，单条 base64 音频也可能到几十 MB；按句切分后首句即可出声，
   * 单段体积也可控。暂停/继续作用在当前句，停止会中止整个队列。
   */
  const speakDeepseek = async (text: string, cfg: { voice: string; apiKey: string; baseUrl: string }) => {
    const ctl = {
      cancelled: false,
      paused: false,
      resumeWaiters: [] as Array<() => void>,
      finish: null as (() => void) | null,
    }
    deepseekCtlRef.current = ctl
    setTtsState('speaking')
    try {
      for (const chunk of splitTtsChunks(text)) {
        if (ctl.cancelled) return
        const res = await window.api.tts.speak(chunk, {
          provider: 'deepseek',
          voice: cfg.voice || 'stella',
          rate: 1,
          apiKey: cfg.apiKey,
          baseUrl: cfg.baseUrl || 'https://api.deepseek.com',
        })
        if (ctl.cancelled) return
        if (!res.success || !res.audioBase64) throw new Error(res.error || '朗读失败')
        // 合成期间点过暂停：等恢复后再播放这一句
        if (ctl.paused) await new Promise<void>((resolve) => ctl.resumeWaiters.push(resolve))
        if (ctl.cancelled) return
        // DeepSeek 返回 wav（audioMime），其余 provider 缺省按 mp3 播放
        const audio = new Audio(`data:${res.audioMime || 'audio/mp3'};base64,${res.audioBase64}`)
        audioRef.current = audio
        await new Promise<void>((resolve) => {
          ctl.finish = () => { ctl.finish = null; resolve() }
          audio.onended = () => ctl.finish?.()
          audio.onerror = () => ctl.finish?.()
          void audio.play().catch(() => ctl.finish?.())
        })
      }
    } catch (err) {
      if (!ctl.cancelled) {
        useChatStore.setState({ error: `朗读失败: ${err instanceof Error ? err.message : String(err)}` })
      }
    } finally {
      if (deepseekCtlRef.current === ctl) deepseekCtlRef.current = null
      setTtsState('idle')
    }
  }

  const handleSpeak = async () => {
    if (!ttsConfig) return
    // 原文朗读口径：默认剥离内心想法（<thought> 块）；开启"朗读内心想法"时仅去掉标签、保留内容
    const originalSpeakText = sanitizeTtsText(
      settings.ttsReadThought ? stripThoughtTags(message.content) : stripThought(message.content),
    )
    // 气泡正在显示译文时朗读译文（与屏幕内容一致）；译文为空或被清空时回退原文
    const translatedSpeakText = showTranslation && translatedText ? sanitizeTtsText(stripThought(translatedText)) : ''
    const speakText = translatedSpeakText || originalSpeakText
    if (!speakText) {
      // 消息可能只有图片/音频/代码等非文本内容：不发起朗读，明确告知
      pushToast({
        variant: 'info',
        title: '这条消息没有可朗读的文字',
        description: '图片、音频、代码等非文本内容会自动跳过',
      })
      return
    }

    // DeepSeek：分句合成、边合成边播；暂停/继续只作用于当前句
    if (ttsConfig.provider === 'deepseek') {
      if (ttsState === 'speaking') {
        const ctl = deepseekCtlRef.current
        if (ctl) {
          ctl.paused = true
          audioRef.current?.pause()
        }
        setTtsState('paused')
        return
      }
      if (ttsState === 'paused') {
        const ctl = deepseekCtlRef.current
        if (ctl) {
          ctl.paused = false
          for (const resolve of ctl.resumeWaiters.splice(0)) resolve()
          void audioRef.current?.play()
        }
        setTtsState('speaking')
        return
      }
      void speakDeepseek(speakText, ttsConfig)
      return
    }

    // OpenAI / Edge / 小米 MiMo TTS：渲染进程直接控制音频播放（主进程返回 base64 音频）
    try {
      if (ttsConfig.provider === 'openai' || ttsConfig.provider === 'edge' || ttsConfig.provider === 'xiaomi') {
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
            : ttsConfig.provider === 'xiaomi'
              ? {
                  provider: 'xiaomi',
                  voice: ttsConfig.voice || 'mimo_default',
                  rate: 1,
                  model: ttsConfig.model || 'mimo-v2.5-tts',
                  apiKey: ttsConfig.apiKey,
                  baseUrl: ttsConfig.baseUrl || 'https://api.xiaomimimo.com/v1',
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
          const audio = new Audio(`data:${res.audioMime || 'audio/mp3'};base64,${res.audioBase64}`)
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
    const ctl = deepseekCtlRef.current
    if (ctl) {
      // 先中止队列：合成中的下一句回来后会直接丢弃，暂停等待也会被唤醒
      ctl.cancelled = true
      for (const resolve of ctl.resumeWaiters.splice(0)) resolve()
      ctl.finish?.()
    }
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
    // 如果已有翻译结果（内存状态或持久化的 message.translation），切换显示
    if (transState?.status === 'done' || message.translation) {
      useChatStore.getState().toggleTranslation(message.id)
      return
    }
    // 发起翻译（翻译完成后会在 onComplete 中自动加入 showTranslationIds 显示译文）
    translateMessage(message.id, message.content)
  }

  const handleBranch = async () => {
    if (!character) return
    try {
      const { messages, sessions: sourceSessions, currentSessionId } = useChatStore.getState()
      const sourceSession = sourceSessions.find((session) => session.id === currentSessionId)
      const branchTitle = sourceSession ? `${sourceSession.title} · 分支` : '对话分支'
      // 分支名继承原会话标题，避免将消息正文暴露在会话列表中
      const branchSession = await window.api.chat.createSession(character.id, branchTitle)
      if (!branchSession) return
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

  /** AI 消息重新生成：加载 preset/lorebook 上下文后重跑（P-7：复用 getActiveChatConfig） */
  const handleRegenerate = async () => {
    if (!character) return
    const chatStore = useChatStore.getState()
    const { preset, lorebooks } = await chatStore.getActiveChatConfig()
    await regenerateMessage(message.id, character, preset, lorebooks).catch((e) => {
      // 与续写按钮一致：IPC/加载失败时提示而非静默
      useChatStore.setState({ error: `重新生成失败: ${e instanceof Error ? e.message : String(e)}` })
    })
  }

  /** 重新生图（生图消息）——UEX-P2-01：全部失败路径提示，不再静默；成功轻提示 */
  const handleRegenerateImage = async () => {
    setRegenerating(true)
    try {
      const result = await window.api.imageGen.generate(message.content)
      if (result.success && result.images?.length) {
        await updateMessageImages(message.id, result.images)
        // UEX-P2-01：成功轻提示（低噪短时长）
        pushToast({ variant: 'success', title: '已重新生成', durationMs: 3000 })
      } else {
        // UEX-P2-01：失败 / 未返回图片均可见提示
        pushToast({ variant: 'error', title: '重新生图失败', description: result.error || '生图服务未返回图片' })
      }
    } catch (e) {
      // UEX-P2-01：异常不再吞掉
      pushToast({ variant: 'error', title: '重新生图失败', description: e instanceof Error ? e.message : String(e) })
    } finally {
      setRegenerating(false)
    }
  }

  const iconBtn = 'p-1.5 rounded text-tavern-text-muted hover:text-tavern-text hover:bg-tavern-bg-hover transition-colors'

  // 删除确认（三个布局分支共用；早退分支必须一并渲染，否则删除按钮失效）
  const deleteConfirm = (
    <ConfirmDialog
      open={confirmDelete}
      onClose={() => setConfirmDelete(false)}
      onConfirm={() => {
        if (character) void deleteMessage(message.id, character)
      }}
      title="删除消息"
      message="确定删除这条消息吗？删除后上下文与长记忆检索将不再包含该内容。此操作不可撤销。"
      confirmText="删除"
      danger
    />
  )

  if (isStreaming) return null

  // 纯图片 system 消息（生图结果）：独立居中布局
  if (bare) {
    return (
      <>
      <div className="flex items-center justify-center gap-1 mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button className={iconBtn} onClick={onEdit} title="编辑"><Edit2 className="w-3.5 h-3.5" /></button>
        <button className={iconBtn} onClick={handleCopy} title="复制"><Copy className="w-3.5 h-3.5" /></button>
        {onReply && (
          <button className="p-1.5 rounded text-tavern-text-muted hover:text-tavern-accent hover:bg-tavern-bg-hover transition-colors" onClick={onReply} title="引用回复"><Reply className="w-3.5 h-3.5" /></button>
        )}
        <button className="p-1.5 rounded text-tavern-text-muted hover:text-tavern-accent hover:bg-tavern-bg-hover transition-colors disabled:opacity-50" disabled={regenerating} onClick={handleRegenerateImage} title="重新生图">
          {regenerating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
        </button>
        <button className="p-1.5 rounded text-tavern-text-muted hover:text-tavern-danger hover:bg-tavern-bg-hover transition-colors" onClick={() => setConfirmDelete(true)} title="删除"><Trash2 className="w-3.5 h-3.5" /></button>
      </div>
      {deleteConfirm}
      </>
    )
  }

  // 用户消息
  if (isUser) {
    return (
      <>
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
          onClick={() => setConfirmDelete(true)}
          title="删除"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
      {deleteConfirm}
      </>
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
            title={ttsState === 'speaking' ? '暂停' : ttsState === 'paused' ? '继续' : (showTranslation && translatedText ? '朗读译文' : '朗读')}
          >
            <MorphingIcon
              icon={ttsState === 'speaking' ? Pause : ttsState === 'paused' ? Play : Volume2}
              className="w-3.5 h-3.5"
            />
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
        onClick={() => setConfirmDelete(true)}
        title="删除"
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>
      {deleteConfirm}
    </div>
  )
})
