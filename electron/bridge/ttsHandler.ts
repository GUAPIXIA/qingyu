/**
 * 桥接层 TTS 端点处理器（方案 §3.3：PC 中转音频流，独立 HTTP 通道）。
 *
 * GET /api/v1/sessions/:id/messages/:mid/tts -> audio/mpeg（mp3，支持 Range）
 * - 朗读前预处理对齐渲染层 MessageActionBar：默认剥离 <thought> 块；
 *   开启"朗读内心想法"（settings.ttsReadThought）时仅去标签保留内容；
 * - 复用 PC 侧 TTS 引擎（electron/ipc/tts.ts 的 edgeSpeak/openaiSpeak）；
 * - provider system（Windows System.Speech）不支持流式输出，返回 501。
 */
import { join } from 'node:path'
import { readJson, DIRS } from '../services/storage'
import { chatData } from '../ipc/chat'
import { edgeSpeak, openaiSpeak } from '../ipc/tts'
import { getDefaultSettings } from '../../shared/defaults'
import { findSessionById } from './sessionsIndex'
import { safeId } from '../utils/pathGuard'
import { createLogger } from '../services/logger'
import type { Request, Response } from 'express'
import type { Settings, TTSModelConfig } from '../../shared/types'

const log = createLogger('bridge-tts')

/** 朗读前预处理（对齐渲染层 MessageActionBar 的 stripThought / stripThoughtTags） */
export function preprocessForTts(content: string, includeThought: boolean): string {
  if (!content) return ''
  const normalized = content
    .replace(/<thinking([\s>])/gi, '<thought$1')
    .replace(/<\/thinking>/gi, '</thought>')
  if (includeThought) {
    return normalized.replace(/<\/?thought>/gi, '').trim()
  }
  return normalized.replace(/<thought>[\s\S]*?<\/thought>/gi, '').trim()
}

/** 读取活跃 TTS 模型配置（对齐渲染层 getActiveTTSConfig） */
function readActiveTtsConfig(): TTSModelConfig | null {
  const settingsFile = join(DIRS.config(), 'settings.json')
  const settings = readJson<Settings>(settingsFile, 'settings') ?? getDefaultSettings()
  if (!settings.activeTTSModelId) return null
  return settings.ttsModels.find((m) => m.id === settings.activeTTSModelId && m.enabled) ?? null
}

/** TTS 端点处理器 */
export async function handleTts(req: Request, res: Response): Promise<void> {
  try {
    const sessionId = safeId(req.params.sessionId)
    const messageId = safeId(req.params.messageId)
    const session = await findSessionById(sessionId)
    if (!session) {
      res.status(404).json({ error: '会话不存在' })
      return
    }
    const messages = chatData.readMessages(session.characterId, sessionId)
    const target = messages.find((m) => m.id === messageId)
    if (!target || !target.content) {
      res.status(404).json({ error: '消息不存在或不可朗读' })
      return
    }

    const settingsFile = join(DIRS.config(), 'settings.json')
    const settings = readJson<Settings>(settingsFile, 'settings') ?? getDefaultSettings()
    const includeThought = settings.ttsReadThought ?? false
    const text = preprocessForTts(target.content, includeThought)
    if (!text.trim()) {
      res.status(400).json({ error: '无可朗读内容（消息仅包含心理描写且未开启朗读内心想法）' })
      return
    }

    const tts = readActiveTtsConfig()
    if (!tts) {
      res.status(400).json({ error: '未配置活跃 TTS 模型（设置 → API 设置 → TTS）' })
      return
    }

    let audioBase64: string
    if (tts.provider === 'edge') {
      audioBase64 = await edgeSpeak(text, tts.voice || 'zh-CN-XiaoxiaoNeural', { proxy: tts.proxy || undefined })
    } else if (tts.provider === 'openai') {
      audioBase64 = await openaiSpeak(
        {
          baseUrl: tts.baseUrl || 'https://api.openai.com/v1',
          apiKey: tts.apiKey,
          model: tts.model || 'tts-1',
          voice: tts.voice || 'alloy',
        },
        text,
      )
    } else {
      res.status(501).json({ error: 'system 语音不支持流式输出，请配置 Edge/OpenAI TTS' })
      return
    }

    const buf = Buffer.from(audioBase64, 'base64')
    log.info('TTS 合成完成', { messageId, provider: tts.provider, bytes: buf.length })
    res.set({
      'Content-Type': 'audio/mpeg',
      'Content-Length': String(buf.length),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=300',
    })
    res.send(buf)
  } catch (e) {
    log.warn('TTS 合成失败', { error: (e as Error).message })
    res.status(500).json({ error: `TTS 合成失败：${(e as Error).message}` })
  }
}
