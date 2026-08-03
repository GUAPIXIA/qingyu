/**
 * Vision 图片转换工具
 *
 * 将消息中的图片（data URL 数组）转换为各 provider 的 API 格式：
 * - OpenAI 兼容: content 数组 [{type:'text'}, {type:'image_url'}]
 * - Claude:      content 数组 [{type:'text'}, {type:'image', source:{base64}}]
 * - Gemini:      parts 数组 [{text}, {inline_data}]
 * - Ollama:      消息级 images 字段（纯 base64，无 data: 前缀）
 *
 * 约定：ChatParams.messages[].images 为 data URL 数组（如 data:image/png;base64,xxx）。
 * 无图片的消息保持原样（content 字符串），保证与不支持视觉的服务完全兼容。
 */

/** 解析后的图片引用 */
export interface ParsedImage {
  /** MIME 类型，如 image/png */
  mimeType: string
  /** 纯 base64（不含 data: 前缀与 MIME 头） */
  data: string
  /** 原始 data URL */
  dataUrl: string
}

/** 解析 data URL（data:image/png;base64,xxx），非法输入返回 null */
export function parseImageDataUrl(dataUrl: unknown): ParsedImage | null {
  if (typeof dataUrl !== 'string') return null
  const s = dataUrl.trim()
  const m = /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(s)
  if (!m) return null
  return { mimeType: m[1], data: m[2].replace(/\s/g, ''), dataUrl: s }
}

/** 输入消息（适配器收到的 ChatParams.messages 元素） */
export type ImageMessage = { role: string; content: string; images?: string[]; [key: string]: unknown }

/** 提取消息列表中的全部图片（保留顺序） */
export function collectImages(messages: ImageMessage[]): ParsedImage[] {
  const out: ParsedImage[] = []
  for (const m of messages) {
    for (const u of m.images ?? []) {
      const p = parseImageDataUrl(u)
      if (p) out.push(p)
    }
  }
  return out
}

/** 消息列表中是否存在带图片的消息 */
export function hasImageMessages(messages: ImageMessage[]): boolean {
  return messages.some((m) => m.images && m.images.length > 0)
}

/**
 * 请求失败时附加的图片诊断提示（仅当请求包含图片时追加）。
 * 用于区分「模型不支持视觉」与普通 API 错误。
 */
export function imageErrorHint(messages: ImageMessage[]): string {
  if (!hasImageMessages(messages)) return ''
  return '。请求包含图片：请确认该模型支持视觉输入（如 gpt-4o、qwen-vl 系列），且网关支持 data URL 图片格式'
}

/** OpenAI 兼容 content 数组元素 */
export type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

/**
 * 转换为 OpenAI 兼容消息：
 * 带图片的消息 content 变为 [{type:'text'}, {type:'image_url',...}] 数组，
 * 无图片消息原样返回（content 保持字符串，兼容不支持视觉的服务）。
 */
export function toOpenAIContent(messages: ImageMessage[]): Record<string, unknown>[] {
  return messages.map((m) => {
    if (!m.images || m.images.length === 0) return m
    const parts: OpenAIContentPart[] = [
      { type: 'text', text: m.content ?? '' },
      ...m.images
        .map((u) => parseImageDataUrl(u))
        .filter((p): p is ParsedImage => p !== null)
        .map((p) => ({ type: 'image_url' as const, image_url: { url: p.dataUrl } })),
    ]
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { images: _images, ...rest } = m
    return { ...rest, content: parts }
  })
}

/** Claude content 数组元素 */
export type ClaudeContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }

/** 转换为 Claude 消息格式（content 数组，base64 image source） */
export function toClaudeContent(messages: ImageMessage[]): Record<string, unknown>[] {
  return messages.map((m) => {
    if (!m.images || m.images.length === 0) return m
    const parts: ClaudeContentPart[] = [
      { type: 'text', text: m.content ?? '' },
      ...m.images
        .map((u) => parseImageDataUrl(u))
        .filter((p): p is ParsedImage => p !== null)
        .map((p) => ({
          type: 'image' as const,
          source: { type: 'base64' as const, media_type: p.mimeType, data: p.data },
        })),
    ]
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { images: _images, ...rest } = m
    return { ...rest, content: parts }
  })
}

/**
 * 转换为 Ollama 消息格式：
 * Ollama 要求消息级 images 字段（纯 base64，不接受 data: 前缀）。
 * 无图片消息原样返回。
 */
export function toOllamaMessages(messages: ImageMessage[]): Record<string, unknown>[] {
  return messages.map((m) => {
    if (!m.images || m.images.length === 0) return m
    const base64List = m.images
      .map((u) => parseImageDataUrl(u))
      .filter((p): p is ParsedImage => p !== null)
      .map((p) => p.data)
    if (base64List.length === 0) return m
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { images: _images, ...rest } = m
    return { ...rest, images: base64List }
  })
}
