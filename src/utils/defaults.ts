export { getDefaultSettings } from '../../shared/defaults'

/** 提供商显示信息 */
export const PROVIDER_INFO = {
  openai: { name: 'OpenAI 兼容', description: 'OpenAI、DeepSeek、Kimi、智创聚合等', placeholder: 'sk-...', keyLabel: 'API Key' },
  claude: { name: 'Claude', description: 'Anthropic 原生 API', placeholder: 'sk-ant-...', keyLabel: 'API Key' },
  gemini: { name: 'Google Gemini', description: 'Google AI Studio', placeholder: 'AIza...', keyLabel: 'API Key' },
  ollama: { name: 'Ollama (本地)', description: '本地部署的模型，无需密钥', placeholder: '无需密钥', keyLabel: 'API Key（可选）' },
  openrouter: { name: 'OpenRouter', description: '路由聚合，一个 key 访问全模型', placeholder: 'sk-or-...', keyLabel: 'API Key' },
  vllm: { name: 'vLLM (本地)', description: '本地推理服务（OpenAI 兼容）', placeholder: '无需密钥', keyLabel: 'API Key（可选）' },
  lmstudio: { name: 'LM Studio (本地)', description: 'LM Studio 本地推理', placeholder: '无需密钥', keyLabel: 'API Key（可选）' },
  tabby: { name: 'TabbyAPI', description: 'exllamav2 本地推理', placeholder: '无需密钥', keyLabel: 'API Key（可选）' },
  deepseek: { name: 'DeepSeek', description: '深度求索，高性价比', placeholder: 'sk-...', keyLabel: 'API Key' },
  groq: { name: 'Groq', description: '极速推理（Llama 系列）', placeholder: 'gsk_...', keyLabel: 'API Key' },
  siliconflow: { name: '硅基流动', description: '国内多模型聚合', placeholder: 'sk-...', keyLabel: 'API Key' },
} as const

/** 无需 API Key 的本地提供商 */
export const LOCAL_PROVIDERS: readonly string[] = ['ollama', 'vllm', 'lmstudio', 'tabby']

/** 是否本地提供商（无需 API Key 即可连接） */
export function isLocalProvider(provider: string | null | undefined): boolean {
  return !!provider && LOCAL_PROVIDERS.includes(provider)
}

/**
 * 是否本地地址（localhost / 127.0.0.1 / 0.0.0.0 / ::1）
 * 本地部署的 OpenAI 兼容服务（vLLM / LM Studio / TabbyAPI 等）无需 API Key，
 * 协议类型统一为 openai 后据此判定免 Key。
 */
export function isLocalUrl(baseUrl: string | null | undefined): boolean {
  if (!baseUrl) return false
  return /^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?)(?::\d+)?(?:\/|$)/i.test(baseUrl.trim())
}

/** 是否为无需单独 API Key 的 OpenCode Go 订阅端点。 */
export function isOpenCodeGoUrl(baseUrl: string | null | undefined): boolean {
  if (!baseUrl) return false
  try {
    const url = new URL(baseUrl.trim())
    return url.protocol === 'https:'
      && url.hostname.toLowerCase() === 'opencode.ai'
      && /^\/zen\/go\/v1\/?$/i.test(url.pathname)
  } catch {
    return false
  }
}

/** 判断连接配置是否具备发起请求所需的凭据。 */
export function isConnectionConfigured(profile: {
  provider: string
  baseUrl?: string | null
  apiKey?: string | null
} | null | undefined): boolean {
  return !!profile && (
    isLocalProvider(profile.provider)
    || isLocalUrl(profile.baseUrl)
    || isOpenCodeGoUrl(profile.baseUrl)
    || !!profile.apiKey?.trim()
  )
}

/** 主题色信息 */
export const THEME_COLORS = {
  amber: { name: '琥珀金', color: '#d4a574' },
  emerald: { name: '翡翠绿', color: '#6ec97e' },
  ocean: { name: '深海蓝', color: '#5b9bd5' },
  rose: { name: '玫瑰粉', color: '#d57a9b' },
  purple: { name: '星夜紫', color: '#a78bfa' },
  cyan: { name: '碧波青', color: '#22d3ee' },
} as const

/** 内置字体选项 */
export const BUILTIN_FONTS = [
  { value: 'system', label: '系统默认', family: '"Noto Sans SC", "Microsoft YaHei", sans-serif', preview: '轻语对话 ABC' },
  { value: 'arial', label: 'Arial', family: 'Arial, "Helvetica Neue", Helvetica, sans-serif', preview: '轻语对话 ABC' },
  { value: 'yahei', label: '微软雅黑', family: '"Microsoft YaHei", sans-serif', preview: '轻语对话 ABC' },
  { value: 'simsun', label: '宋体', family: '"SimSun", "宋体", serif', preview: '轻语对话 ABC' },
  { value: 'simhei', label: '黑体', family: '"SimHei", "黑体", sans-serif', preview: '轻语对话 ABC' },
  { value: 'kaiti', label: '楷体', family: '"KaiTi", "楷体", serif', preview: '轻语对话 ABC' },
] as const
