/**
 * Instruct 模板配置
 *
 * 已知模型的输入/输出包装格式映射。主要用于 Ollama 自部署模型
 * （模板模式时 Ollama 走 /api/generate 纯文本接口）。
 * OpenAI / Claude / Gemini API 本身是 messages 数组格式，不需要额外包装。
 */

export interface InstructTemplate {
  systemPrefix: string
  systemSuffix: string
  userPrefix: string
  userSuffix: string
  assistantPrefix: string
  assistantSuffix: string
  systemAsTopLevel?: boolean
  stopSequences: string[]
  appendAssistantPrefix: boolean
}

const DEFAULT_TEMPLATE: InstructTemplate = {
  systemPrefix: '',
  systemSuffix: '',
  userPrefix: '',
  userSuffix: '',
  assistantPrefix: '',
  assistantSuffix: '',
  stopSequences: [],
  appendAssistantPrefix: false,
}

const TEMPLATE_MAP: Record<string, Partial<InstructTemplate>> = {
  // ===== ChatML（Qwen / DeepSeek 官方格式）=====
  'chatml': {
    systemPrefix: '<|im_start|>system\n',
    systemSuffix: '<|im_end|>\n',
    userPrefix: '<|im_start|>user\n',
    userSuffix: '<|im_end|>\n',
    assistantPrefix: '<|im_start|>assistant\n',
    assistantSuffix: '<|im_end|>\n',
    stopSequences: ['<|im_end|>', '<|im_start|>'],
    appendAssistantPrefix: true,
  },
  'qwen': {
    systemPrefix: '<|im_start|>system\n',
    systemSuffix: '<|im_end|>\n',
    userPrefix: '<|im_start|>user\n',
    userSuffix: '<|im_end|>\n',
    assistantPrefix: '<|im_start|>assistant\n',
    assistantSuffix: '<|im_end|>\n',
    stopSequences: ['<|im_end|>', '<|im_start|>'],
    appendAssistantPrefix: true,
  },
  'deepseek': {
    systemPrefix: '<|im_start|>system\n',
    systemSuffix: '<|im_end|>\n',
    userPrefix: '<|im_start|>user\n',
    userSuffix: '<|im_end|>\n',
    assistantPrefix: '<|im_start|>assistant\n',
    assistantSuffix: '<|im_end|>\n',
    stopSequences: ['<|im_end|>', '<|im_start|>'],
    appendAssistantPrefix: true,
  },
  // ===== Llama 系列 =====
  'llama2': {
    systemPrefix: '[INST] <<SYS>>\n',
    systemSuffix: '\n<</SYS>>\n\n',
    userPrefix: '[INST] ',
    userSuffix: ' [/INST]',
    assistantPrefix: '',
    assistantSuffix: '</s>',
    stopSequences: ['</s>', '[INST]'],
    appendAssistantPrefix: false,
  },
  'llama3': {
    systemPrefix: '<|start_header_id|>system<|end_header_id|>\n\n',
    systemSuffix: '<|eot_id|>',
    userPrefix: '<|start_header_id|>user<|end_header_id|>\n\n',
    userSuffix: '<|eot_id|>',
    assistantPrefix: '<|start_header_id|>assistant<|end_header_id|>\n\n',
    assistantSuffix: '<|eot_id|>',
    stopSequences: ['<|eot_id|>', '<|start_header_id|>'],
    appendAssistantPrefix: true,
  },
  'command-r': {
    systemPrefix: '<|START_OF_TURN_TOKEN|><|SYSTEM_TOKEN|>',
    systemSuffix: '<|END_OF_TURN_TOKEN|>',
    userPrefix: '<|START_OF_TURN_TOKEN|><|USER_TOKEN|>',
    userSuffix: '<|END_OF_TURN_TOKEN|>',
    assistantPrefix: '<|START_OF_TURN_TOKEN|><|CHATBOT_TOKEN|>',
    assistantSuffix: '<|END_OF_TURN_TOKEN|>',
    stopSequences: ['<|END_OF_TURN_TOKEN|>'],
    appendAssistantPrefix: true,
  },
  'mistral': {
    systemPrefix: '',
    systemSuffix: '',
    userPrefix: '[INST] ',
    userSuffix: ' [/INST]',
    assistantPrefix: '',
    assistantSuffix: '</s>',
    stopSequences: ['</s>', '[INST]'],
    appendAssistantPrefix: false,
  },
  // Phi-3 系列
  'phi3': {
    systemPrefix: '<|system|>\n',
    systemSuffix: '<|end|>\n',
    userPrefix: '<|user|>\n',
    userSuffix: '<|end|>\n',
    assistantPrefix: '<|assistant|>\n',
    assistantSuffix: '<|end|>\n',
    stopSequences: ['<|end|>', '<|user|>'],
    appendAssistantPrefix: true,
  },
  // ===== Alpaca =====
  'alpaca': {
    systemPrefix: '',
    systemSuffix: '\n\n',
    userPrefix: '### Instruction:\n',
    userSuffix: '\n\n### Response:\n',
    assistantPrefix: '',
    assistantSuffix: '\n\n',
    stopSequences: ['### Instruction:', '### Response:'],
    appendAssistantPrefix: false,
  },
  // ===== Gemma =====
  'gemma': {
    systemPrefix: '',
    systemSuffix: '',
    userPrefix: '<start_of_turn>user\n',
    userSuffix: '<end_of_turn>\n',
    assistantPrefix: '<start_of_turn>model\n',
    assistantSuffix: '<end_of_turn>\n',
    stopSequences: ['<end_of_turn>', '<start_of_turn>'],
    appendAssistantPrefix: true,
  },
}

/** 内置模板名列表（供预设 UI 展示） */
export const BUILTIN_TEMPLATE_NAMES = Object.keys(TEMPLATE_MAP).sort()

/** 按模板名解析（未知名称返回 undefined） */
export function getTemplateByName(name: string | undefined | null): InstructTemplate | undefined {
  if (!name) return undefined
  const t = TEMPLATE_MAP[name.toLowerCase().trim()]
  return t ? { ...DEFAULT_TEMPLATE, ...t } : undefined
}

/**
 * 解析生效的 instruct 模板：预设指定 > profile 自动推断 > 无
 */
export function resolveEffectiveTemplate(
  contextTemplate: string | undefined | null,
  provider: string,
  model: string,
  useInstructTemplate: boolean | undefined,
): InstructTemplate | undefined {
  // 1. 预设显式指定模板名
  const explicit = getTemplateByName(contextTemplate)
  if (explicit) return explicit
  // 2. profile 级开关自动推断
  if (useInstructTemplate) {
    return getInstructTemplate(provider, model)
  }
  return undefined
}

export function getInstructTemplate(provider: string, model: string): InstructTemplate {
  const lowerModel = model.toLowerCase()
  const lowerProvider = provider.toLowerCase()

  // 精确模型名匹配
  if (TEMPLATE_MAP[lowerModel]) {
    return { ...DEFAULT_TEMPLATE, ...TEMPLATE_MAP[lowerModel] }
  }

  // 模糊匹配
  for (const [key, template] of Object.entries(TEMPLATE_MAP)) {
    if (lowerModel.includes(key)) {
      return { ...DEFAULT_TEMPLATE, ...template }
    }
  }

  // 按提供商默认行为
  if (lowerProvider === 'claude') {
    return { ...DEFAULT_TEMPLATE, systemAsTopLevel: true }
  }
  if (lowerProvider === 'gemini') {
    return { ...DEFAULT_TEMPLATE, systemAsTopLevel: true }
  }

  return DEFAULT_TEMPLATE
}

/**
 * 按模板将消息数组包装为单个纯文本（用于原始补全接口，如 Ollama /api/generate）
 * @returns 包装后的文本 + 停止序列
 */
export function applyInstructTemplate(
  messages: { role: string; content: string }[],
  template: InstructTemplate,
): { text: string; stopSequences: string[] } {
  let text = ''
  for (const msg of messages) {
    if (msg.role === 'system') {
      text += template.systemPrefix + (msg.content ?? '') + template.systemSuffix
    } else if (msg.role === 'user') {
      text += template.userPrefix + (msg.content ?? '') + template.userSuffix
    } else if (msg.role === 'assistant') {
      text += template.assistantPrefix + (msg.content ?? '') + template.assistantSuffix
    }
  }
  // appendAssistantPrefix：追加空 assistant 前缀，引导模型续写
  if (template.appendAssistantPrefix) {
    text += template.assistantPrefix
  }
  return { text, stopSequences: template.stopSequences }
}
