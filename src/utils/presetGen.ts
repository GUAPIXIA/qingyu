/**
 * AI 生成预设：结构化输出解析
 *
 * 让模型输出：
 *   【SystemPrompt】
 *   <系统提示词>
 *   【Jailbreak】
 *   <越狱提示词（无则写"无"）>
 *   【参数建议】
 *   温度: 0.9
 *   TopP: 0.95
 */

export interface GeneratedPreset {
  systemPrompt: string
  jailbreak: string
  temperature?: number
  topP?: number
}

/** 解析模型输出为预设字段 */
export function parsePresetGeneration(text: string): GeneratedPreset {
  const cleaned = (text ?? '')
    .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .trim()

  const sysMatch = cleaned.match(/【SystemPrompt】([\s\S]*?)(?=【Jailbreak】|【参数建议】|$)/)
  const jbMatch = cleaned.match(/【Jailbreak】([\s\S]*?)(?=【SystemPrompt】|【参数建议】|$)/)
  const paramMatch = cleaned.match(/【参数建议】([\s\S]*)$/)

  const systemPrompt = (sysMatch?.[1] ?? '').trim()
  let jailbreak = (jbMatch?.[1] ?? '').trim()
  // "无" / "无。" 等占位视为空
  if (/^无[。.！!]?$/.test(jailbreak) || jailbreak === '') jailbreak = ''

  // 参数：温度 / TopP
  let temperature: number | undefined
  let topP: number | undefined
  const paramText = paramMatch?.[1] ?? ''
  const tempMatch = paramText.match(/温度\s*[:：]?\s*(\d+(?:\.\d+)?)/)
  const topPMatch = paramText.match(/[Tt]op\s*[Pp]\s*[:：]?\s*(\d+(?:\.\d+)?)/)
  if (tempMatch) {
    const v = Number(tempMatch[1])
    if (v >= 0 && v <= 2) temperature = Math.round(v * 10) / 10
  }
  if (topPMatch) {
    const v = Number(topPMatch[1])
    if (v > 0 && v <= 1) topP = Math.round(v * 100) / 100
  }

  // 兜底：无标记时全文作为 systemPrompt
  return {
    systemPrompt: systemPrompt || cleaned.replace(/【Jailbreak】[\s\S]*$/, '').trim(),
    jailbreak,
    temperature,
    topP,
  }
}
