import type { IpcMain } from 'electron'
import { createLogger } from '../services/logger'
import { generateImage, testImageGenConnection, type ImageGenOptions } from '../services/imageGen'
import { readJson, DIRS } from '../services/storage'
import { join } from 'node:path'
import type { Settings, ConnectionProfile } from '../../shared/types'

const log = createLogger('imageGenIPC')

/** 使用用户的 AI API 将中文 prompt 翻译为英文 */
async function translatePromptToEnglish(prompt: string, settings: Settings): Promise<string> {
  // 获取当前活动的连接 profile
  let profile: ConnectionProfile | undefined
  if (settings.activeProfileId) {
    profile = settings.connectionProfiles?.find(p => p.id === settings.activeProfileId)
  }
  if (!profile) {
    profile = settings.connectionProfiles?.[0]
  }
  if (!profile) {
    throw new Error('没有可用的 API 连接配置')
  }

  // 读取 API Key
  const { readJson: readCredJson } = await import('../services/storage')
  let apiKey = profile.apiKey || ''
  if (!apiKey && profile.id) {
    try {
      const creds = readCredJson<Record<string, string>>(join(DIRS.config(), 'credentials.json'))
      if (creds && creds[profile.id]) {
        apiKey = creds[profile.id]
      }
    } catch { /* ignore */ }
  }
  if (!apiKey) {
    throw new Error('API Key 未配置')
  }

  const baseUrl = profile.baseUrl.replace(/\/$/, '')
  const url = `${baseUrl}/chat/completions`

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: profile.model,
      messages: [
        {
          role: 'system',
          content: 'You are a translator. Translate the following Chinese image generation prompt into English tags separated by commas. Only output the English prompt, nothing else. Do NOT add explanations.',
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
      max_tokens: 200,
    }),
    signal: AbortSignal.timeout(15000),
  })

  if (!response.ok) {
    throw new Error(`翻译 API 返回 ${response.status}`)
  }

  const data: any = await response.json()
  const translated = data?.choices?.[0]?.message?.content?.trim()
  if (!translated) {
    throw new Error('翻译 API 返回空结果')
  }

  return translated
}

export function registerImageGenIPC(ipcMain: IpcMain): void {
  ipcMain.handle('imageGen:generate', async (_e, prompt: string, options?: ImageGenOptions) => {
    try {
      // 从 settings.json 读取完整配置
      const settings = readJson<Settings>(join(DIRS.config(), 'settings.json'))
      if (!settings) {
        return { success: false, error: '设置读取失败' }
      }

      // 找到当前激活的生图模型
      const config = settings.imageGenModels?.find(
        (m) => m.id === settings.activeImageGenModelId && m.enabled,
      )
      if (!config) {
        return { success: false, error: '未配置启用的生图模型，请前往 设置 -> API -> 生图 配置' }
      }

      // 尺寸优先级：options.size > settings.imageGenSize > config.size
      const size = options?.size || settings.imageGenSize || config.size

      // SD WebUI：如果 prompt 包含中文，翻译为英文
      let finalPrompt = prompt
      if (config.provider === 'sd-webui' && /[\u4e00-\u9fff]/.test(prompt)) {
        try {
          const translated = await translatePromptToEnglish(prompt, settings)
          log.info('中文提示词已翻译为英文', {
            original: prompt.substring(0, 60),
            translated: translated.substring(0, 60),
          })
          finalPrompt = translated
        } catch (err: any) {
          log.warn('提示词翻译失败，使用原始提示词', { error: err?.message ?? String(err) })
          // 降级：继续使用原始 prompt
        }
      }

      log.info('生图调用', { provider: config.provider, prompt: finalPrompt.substring(0, 60), size })

      return await generateImage(config, finalPrompt, { ...options, size })
    } catch (err: any) {
      log.error('生图 IPC 异常', { error: err?.message ?? String(err) })
      return { success: false, error: err?.message ?? String(err) }
    }
  })

  ipcMain.handle('imageGen:testConnection', async (_e, config: { provider: string; baseUrl: string; apiKey: string }) => {
    log.info('测试连接', { provider: config.provider, baseUrl: config.baseUrl })
    return testImageGenConnection(config)
  })
}
