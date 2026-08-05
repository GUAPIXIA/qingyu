/**
 * Token 计数服务（Electron 主进程）
 *
 * 优先使用精确 tokenizer（tiktoken），不可用时降级到启发式估算。
 * 加载策略：
 * - 通过 createRequire 动态加载 tiktoken（避免 esbuild 打包 wasm 胶水代码）
 * - 运行时从 bundle 产物所在目录向上解析 node_modules/tiktoken
 *   （dev: dist-electron → 项目根 node_modules；生产: app.asar 内 node_modules）
 */

import { createRequire } from 'node:module'
import { createLogger } from './logger'
import type { Tiktoken } from 'tiktoken'

const log = createLogger('tokenizer')

// 兼容两种构建环境：
// - esbuild CJS 打包（Electron 主进程）：__filename 可用
// - vitest ESM（单元测试）：使用 import.meta.url
const _nodeRequire = createRequire(typeof __filename !== 'undefined' ? __filename : import.meta.url)

/** tiktoken 模块接口（动态加载，避免 esbuild 内联 wasm 相关代码） */
interface TiktokenApi {
  get_encoding(name: string, extend_special_tokens?: Record<string, number>): Tiktoken
  encoding_for_model(model: string, extend_special_tokens?: Record<string, number>): Tiktoken
  get_encoding_name_for_model(model: string): string
}

let _tiktoken: TiktokenApi | null = null

function tryLoadTiktoken(): TiktokenApi | null {
  if (_tiktoken !== undefined) return _tiktoken
  try {
    _tiktoken = _nodeRequire('tiktoken') as TiktokenApi
    log.info('tiktoken 精确分词器加载成功')
    return _tiktoken
  } catch (e) {
    _tiktoken = null
    log.warn(`tiktoken 加载失败，降级到启发式估算: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}

// ===================== 编码选择 =====================

/**
 * 非 OpenAI 模型的编码近似映射。
 * 这些模型没有公开的 JS 分词器，使用 token 效率相近的编码近似：
 * - Claude / Gemini：cl100k_base 是社区通行近似
 * - DeepSeek / Qwen：中文 1 字 ≈ 1 token，o200k_base 与 cl100k_base 均可，取 o200k
 */
const EXTRA_ENCODING_MAP: Array<[pattern: string, encoding: string]> = [
  ['claude', 'cl100k_base'],
  ['gemini', 'cl100k_base'],
  ['deepseek', 'o200k_base'],
  ['qwen', 'o200k_base'],
  ['mistral', 'cl100k_base'],
  ['mixtral', 'cl100k_base'],
  ['llama', 'cl100k_base'],
  ['gpt-4', 'cl100k_base'],
  ['gpt-3', 'cl100k_base'],
  ['gpt2', 'gpt2'],
  ['davinci', 'gpt2'],
  ['curie', 'gpt2'],
  ['babbage', 'gpt2'],
  ['ada', 'gpt2'],
]

/** 解析模型 → 编码名称，未知模型返回 null（走启发式） */
function resolveEncodingName(tiktoken: TiktokenApi, model: string): string | null {
  const lower = model.toLowerCase().trim()
  if (!lower) return null

  // 1. tiktoken 官方模型表（gpt-4o / o1 / o3 / o4 / gpt-4.1 / gpt-5 等 80+ 模型）
  try {
    const name = tiktoken.get_encoding_name_for_model(lower)
    if (name) return name
  } catch {
    // 官方表未命中，继续走近似映射
  }

  // 2. 已知非 OpenAI 模型族的近似映射
  for (const [pattern, encoding] of EXTRA_ENCODING_MAP) {
    if (lower.includes(pattern)) return encoding
  }

  // 3. 完全未知 → 启发式估算
  return null
}

// ===================== 编码实例缓存 =====================

/** 编码实例缓存：tiktoken 每次 get_encoding 都创建新实例，缓存避免频繁分配/释放 */
const encodingCache = new Map<string, Tiktoken>()

function getEncoding(tiktoken: TiktokenApi, name: string): Tiktoken {
  let enc = encodingCache.get(name)
  if (!enc) {
    enc = tiktoken.get_encoding(name)
    encodingCache.set(name, enc)
  }
  return enc
}

// ===================== 启发式兜底 =====================

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

// ===================== 对外 API =====================

/** 精确计数 token 数，失败时降级到启发式估算 */
export function countTokens(text: string, model: string): number {
  if (!text) return 0

  const tiktoken = tryLoadTiktoken()
  if (!tiktoken) return heuristicCount(text, model)

  const encodingName = resolveEncodingName(tiktoken, model)
  if (!encodingName) return heuristicCount(text, model)

  try {
    const enc = getEncoding(tiktoken, encodingName)
    // encode_ordinary：特殊 token（如 <|endoftext|>）按普通文本处理，
    // 防止角色扮演文本中的标签被误解析为特殊 token
    return enc.encode_ordinary(text).length
  } catch (e) {
    log.warn(`tiktoken 计数失败（${encodingName}），降级启发式: ${e instanceof Error ? e.message : String(e)}`)
    return heuristicCount(text, model)
  }
}

/** 每张图片的 token 估算（vision 模型视觉输入开销，OpenAI high-detail 粗略值） */
export const IMAGE_TOKENS_PER_IMAGE = 500

/** 批量计数（每条消息 +4 token 的 role 元数据开销，图片按固定值估算） */
export function countMessagesTokens(
  messages: { content: string; role: string; images?: string[] }[],
  model: string,
): number[] {
  return messages.map(m => countTokens(m.content, model) + 4 + (m.images?.length ?? 0) * IMAGE_TOKENS_PER_IMAGE)
}

/** 当前 tokenizer 工作模式（供调试/设置页展示） */
export function getTokenizerInfo(): { mode: 'tiktoken' | 'heuristic'; encodings: string[] } {
  const tiktoken = tryLoadTiktoken()
  return {
    mode: tiktoken ? 'tiktoken' : 'heuristic',
    encodings: [...encodingCache.keys()],
  }
}
