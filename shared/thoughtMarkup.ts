/**
 * `<thought>` 是产品协议：只表示故事角色的内心独白。
 * `<think>` / `<thinking>` 是常见的供应商或模型推理标记，不能进入角色消息。
 */
const VENDOR_THINKING_BLOCK = /<\s*(?:think|thinking)\b[^>]*>[\s\S]*?(?:<\s*\/\s*(?:think|thinking)\s*>|$)/gi
const ORPHAN_VENDOR_THINKING_TAG = /<\s*\/\s*(?:think|thinking)\s*>/gi

/** 删除供应商推理标记及其内容，同时原样保留产品级 `<thought>` 块。 */
export function stripVendorThinking(text: string): string {
  if (!text) return text
  return text
    .replace(VENDOR_THINKING_BLOCK, '')
    .replace(ORPHAN_VENDOR_THINKING_TAG, '')
}

const PRODUCT_THOUGHT_BLOCK = /<\s*thought\b[^>]*>[\s\S]*?(?:<\s*\/\s*thought\s*>|$)/gi
const ORPHAN_PRODUCT_THOUGHT_TAG = /<\s*\/\s*thought\s*>/gi

/**
 * 辅助链路（翻译/摘要/标题/角色卡生成/生图提示词/TTS 等）的唯一思考清洗入口：
 * 删除供应商推理标记与产品级 `<thought>` 块（含未闭合尾部与孤儿闭合标签）并 trim。
 * 主对话气泡需要保留/提取 thought 内容，不走这里（用 messagePostProcess.extractThought）。
 */
export function stripAllThinking(text: string): string {
  if (!text) return text
  return text
    .replace(VENDOR_THINKING_BLOCK, '')
    .replace(ORPHAN_VENDOR_THINKING_TAG, '')
    .replace(PRODUCT_THOUGHT_BLOCK, '')
    .replace(ORPHAN_PRODUCT_THOUGHT_TAG, '')
    .trim()
}

/**
 * 流式删除器：跨 chunk 识别 `<think>` / `<thinking>`，只向 UI 放行可见正文。
 * 未闭合的供应商推理块在流结束时整体丢弃。
 */
export function createVendorThinkingStreamFilter(): {
  push: (chunk: string) => string
  flush: () => string
} {
  let pending = ''
  let insideVendorThinking = false
  const openTag = /<\s*(?:think|thinking)\b[^>]*>/i
  const closeTag = /<\s*\/\s*(?:think|thinking)\s*>/i

  const potentialOpenStart = (value: string): number => {
    const start = value.lastIndexOf('<')
    if (start < 0) return -1
    const candidate = value.slice(start).toLowerCase()
    if (candidate.includes('>')) return -1
    const match = candidate.match(/^<\s*([a-z]*)/)
    if (!match) return -1
    const letters = match[1]
    const remainder = candidate.slice(match[0].length)
    if (!letters) return remainder ? -1 : start
    if (letters === 'think' || letters === 'thinking') {
      return !remainder || /^\s/.test(remainder) ? start : -1
    }
    if (!remainder && ('think'.startsWith(letters) || 'thinking'.startsWith(letters))) return start
    return -1
  }

  return {
    push(chunk: string): string {
      if (!chunk) return ''
      pending += chunk
      let visible = ''

      while (pending) {
        if (insideVendorThinking) {
          const close = closeTag.exec(pending)
          if (!close) return visible
          pending = pending.slice(close.index + close[0].length)
          insideVendorThinking = false
          continue
        }

        const open = openTag.exec(pending)
        if (open) {
          visible += pending.slice(0, open.index)
          pending = pending.slice(open.index + open[0].length)
          insideVendorThinking = true
          continue
        }

        const partialStart = potentialOpenStart(pending)
        if (partialStart >= 0) {
          visible += pending.slice(0, partialStart)
          pending = pending.slice(partialStart)
        } else {
          visible += pending
          pending = ''
        }
        return visible
      }
      return visible
    },
    flush(): string {
      if (insideVendorThinking) {
        pending = ''
        return ''
      }
      const visible = pending
      pending = ''
      return visible
    },
  }
}
