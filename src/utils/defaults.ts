import type { Settings } from '../../shared/types'

export function getDefaultSettings(): Settings {
  return {
    activeProvider: 'openai',
    providers: {
      openai: { type: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
      claude: { type: 'claude', baseUrl: 'https://api.anthropic.com', model: 'claude-3-5-sonnet-20241022' },
      gemini: { type: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-1.5-flash' },
      ollama: { type: 'ollama', baseUrl: 'http://localhost:11434', model: 'llama3.2' },
    },
    connectionProfiles: [],
    activeProfileId: null,
    activeModel: 'gpt-4o-mini',
    activePresetId: 'builtin-default',
    activeCharacterId: null,
    theme: 'dark',
    themeColor: 'amber',
    fontSize: 'comfortable',
    fontSizeCustom: 0,
    bubbleStyle: 'round',
    messageSpacing: 20,
    streamOutput: true,
    autoScroll: true,
    ttsEnabled: false,
    ttsModels: [],
    activeTTSModelId: null,
    imageGenModels: [],
    activeImageGenModelId: null,
    visionModels: [],
    activeVisionModelId: null,
    userName: '用户',
    userDescription: '',
    userPersona: '',
    activePersonaId: null,
    htmlRendering: false,
    showTokenCount: true,
    enableThoughtFormat: true,
    enableUsageTracking: true,
    useCoverAsBackground: false,
    pricingRules: [
      { id: 'builtin-gpt4o', modelPattern: 'gpt-4o*', inputPricePer1M: 2.5, outputPricePer1M: 10, isBuiltin: true },
      { id: 'builtin-gpt4o-mini', modelPattern: 'gpt-4o-mini*', inputPricePer1M: 0.15, outputPricePer1M: 0.6, isBuiltin: true },
      { id: 'builtin-claude35', modelPattern: 'claude-3-5*', inputPricePer1M: 3, outputPricePer1M: 15, isBuiltin: true },
      { id: 'builtin-claude37', modelPattern: 'claude-3-7*', inputPricePer1M: 3, outputPricePer1M: 15, isBuiltin: true },
      { id: 'builtin-gemini', modelPattern: 'gemini-*', inputPricePer1M: 1.25, outputPricePer1M: 5, isBuiltin: true },
      { id: 'builtin-deepseek', modelPattern: 'deepseek*', inputPricePer1M: 0.14, outputPricePer1M: 0.28, isBuiltin: true },
      { id: 'builtin-qwen', modelPattern: 'qwen*', inputPricePer1M: 0.5, outputPricePer1M: 1.5, isBuiltin: true },
    ],
  }
}

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
