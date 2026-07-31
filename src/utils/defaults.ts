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
} as const

/** 无需 API Key 的本地提供商 */
export const LOCAL_PROVIDERS: readonly string[] = ['ollama', 'vllm', 'lmstudio', 'tabby']

/** 是否本地提供商（无需 API Key 即可连接） */
export function isLocalProvider(provider: string | null | undefined): boolean {
  return !!provider && LOCAL_PROVIDERS.includes(provider)
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
