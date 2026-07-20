/**
 * Instruct 模板配置
 * 
 * 已知模型的输入/输出包装格式映射。主要用于 Ollama 自部署模型。
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
