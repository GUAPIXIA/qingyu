/**
 * Token 计数服务（Electron 主进程）
 * 优先使用精确 tokenizer（如 tiktoken），不可用时降级到启发式估算。
 * IPC 基础设施已就绪，安装 tiktoken 后自动生效。
 */

// P-7 修复：模块级缓存 tiktoken 实例，避免每次调用都 require
let _tiktoken: typeof import('tiktoken') | null = undefined
function tryLoadTiktoken(): typeof import('tiktoken') | null {
  if (_tiktoken !== undefined) return _tiktoken
  try {
    _tiktoken = require('tiktoken')
    return _tiktoken
  } catch {
    _tiktoken = null
    return null
  }
}

/** 模型名 → tiktoken 编码名映射 */
const MODEL_ENCODING_MAP: Record<string, string> = {
  'gpt-4o': 'o200k_base',
  'gpt-4o-mini': 'o200k_base',
  'gpt-4-turbo': 'cl100k_base',
  'gpt-4': 'cl100k_base',
  'gpt-3.5-turbo': 'cl100k_base',
  'claude-3': 'cl100k_base',
  'claude-3.5': 'cl100k_base',
  'claude-3-opus': 'cl100k_base',
  'claude-3-haiku': 'cl100k_base',
  'claude-3.7': 'cl100k_base',
  'gemini': 'cl100k_base',
}

/** 按模型族的启发式系数 */
function heuristicCoeffs(model: string): { chPerEnTok: number; chPerZhTok: number } {
  const lower = model.toLowerCase()
  if (lower.includes('claude')) return { chPerEnTok: 3.6, chPerZhTok: 0.85 }
  if (lower.includes('gemini')) return { chPerEnTok: 3.3, chPerZhTok: 0.9 }
  // OpenAI / Ollama 默认值
  return { chPerEnTok: 3.4, chPerZhTok: 0.9 }
}

/** 启发式 token 计数（按模型族优化） */
function heuristicCount(text: string, model: string): number {
  if (!text) return 0
  const { chPerEnTok, chPerZhTok } = heuristicCoeffs(model)

  // 分类统计字符
  const cjkChars = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) ?? []).length
  const punctuation = (text.match(/[，。！？；：""''（）【】《》、\s]/g) ?? []).length
  const englishLike = text.length - cjkChars - punctuation

  return Math.ceil(cjkChars * chPerZhTok + punctuation * 0.25 + englishLike / chPerEnTok)
}

/** 精确计数 token 数，失败时降级到启发式估算 */
export function countTokens(text: string, model: string): number {
  if (!text) return 0

  const tiktoken = tryLoadTiktoken()
  if (!tiktoken) return heuristicCount(text, model)

  // 有 tiktoken → 精确计数
  let encodingName = MODEL_ENCODING_MAP[model.toLowerCase()]
  if (!encodingName) {
    for (const [key, enc] of Object.entries(MODEL_ENCODING_MAP)) {
      if (model.toLowerCase().includes(key)) { encodingName = enc; break }
    }
  }

  if (!encodingName) return heuristicCount(text, model)

  try {
    const enc = tiktoken.get_encoding(encodingName)
    const tokens = enc.encode(text)
    enc.free()
    return tokens.length
  } catch {
    return heuristicCount(text, model)
  }
}

/** 批量计数（每条消息 +4 token 的 role 元数据开销） */
export function countMessagesTokens(
  messages: { content: string; role: string }[],
  model: string,
): number[] {
  return messages.map(m => countTokens(m.content, model) + 4)
}
