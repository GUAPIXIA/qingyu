export { getDefaultSettings } from '../../shared/defaults'

/** 提供商显示信息 */
export const PROVIDER_INFO = {
  openai: { name: 'OpenAI 兼容', description: 'OpenAI、DeepSeek、Kimi、智创聚合等', placeholder: 'sk-...', keyLabel: 'API Key' },
  claude: { name: 'Claude', description: 'Anthropic 原生 API', placeholder: 'sk-ant-...', keyLabel: 'API Key' },
  gemini: { name: 'Google Gemini', description: 'Google AI Studio', placeholder: 'AIza...', keyLabel: 'API Key' },
  ollama: { name: 'Ollama (本地)', description: '本地部署的模型，无需密钥', placeholder: '无需密钥', keyLabel: 'API Key（可选）' },
} as const

/** 主题色信息 */
export const THEME_COLORS = {
  amber: { name: '琥珀金', color: '#d4a574' },
  emerald: { name: '翡翠绿', color: '#6ec97e' },
  ocean: { name: '深海蓝', color: '#5b9bd5' },
  rose: { name: '玫瑰粉', color: '#d57a9b' },
  purple: { name: '星夜紫', color: '#a78bfa' },
  cyan: { name: '碧波青', color: '#22d3ee' },
} as const
