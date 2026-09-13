import type { Preset, PresetImportResult, ResponseLengthMode } from './types'

const VALID_EXAMPLE_MODES = new Set(['always', 'first_turn', 'off'])

const VALID_RESPONSE_LENGTH_HINTS = new Set(['auto', 'brief', 'balanced', 'detailed'])

const NATIVE_PRESET_FIELDS = new Set([
  'id', 'name', 'description', 'systemPrompt', 'jailbreak',
  'maxContext', 'temperature', 'topP', 'maxTokens', 'responseLengthHint',
  'frequencyPenalty', 'presencePenalty', 'isBuiltin',
  'contextTemplate', 'group', 'exampleDialogMode', 'enableThoughtFormat',
])

const STANDARD_FIELD_MAP: Record<string, keyof Preset> = {
  main_prompt: 'systemPrompt',
  jailbreak_prompt: 'jailbreak',
  max_context: 'maxContext',
  top_p: 'topP',
  max_tokens: 'maxTokens',
  frequency_penalty: 'frequencyPenalty',
  presence_penalty: 'presencePenalty',
  context_template: 'contextTemplate',
}

function finiteNumber(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

/**
 * Normalize untrusted imported/IPC preset data before it is persisted.
 * Keeps old preset files compatible while preventing invalid values from
 * reaching provider adapters.
 */
export function normalizePreset(input: unknown): Preset {
  if (!input || typeof input !== 'object') throw new Error('预设格式无效')
  const raw = input as Record<string, unknown>
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (!id) throw new Error('预设 ID 不能为空')
  if (!name) throw new Error('预设名称不能为空')

  const preset: Preset = {
    id,
    name: name.slice(0, 100),
    description: typeof raw.description === 'string' ? raw.description : '',
    systemPrompt: typeof raw.systemPrompt === 'string' ? raw.systemPrompt : '',
    jailbreak: typeof raw.jailbreak === 'string' ? raw.jailbreak : '',
    maxContext: Math.round(finiteNumber(raw.maxContext, 0, 0, 2_000_000)),
    temperature: finiteNumber(raw.temperature, 0.8, 0, 2),
    topP: finiteNumber(raw.topP, 0.95, 0.01, 1),
    // 0 = 自动动态预算；正数 = 用户明确设置的严格硬上限。
    maxTokens: Math.round(finiteNumber(raw.maxTokens, 0, 0, 262_144)),
    frequencyPenalty: finiteNumber(raw.frequencyPenalty, 0, -2, 2),
    presencePenalty: finiteNumber(raw.presencePenalty, 0, -2, 2),
    isBuiltin: raw.isBuiltin === true,
  }

  if (typeof raw.contextTemplate === 'string' && raw.contextTemplate.trim()) {
    preset.contextTemplate = raw.contextTemplate.trim()
  }
  if (typeof raw.group === 'string' && raw.group.trim()) {
    preset.group = raw.group.trim().slice(0, 50)
  }
  if (typeof raw.exampleDialogMode === 'string' && VALID_EXAMPLE_MODES.has(raw.exampleDialogMode)) {
    preset.exampleDialogMode = raw.exampleDialogMode as Preset['exampleDialogMode']
  }
  if (typeof raw.enableThoughtFormat === 'boolean') {
    preset.enableThoughtFormat = raw.enableThoughtFormat
  }
  // 篇幅提示：合法值透传；缺失/无效时补 'auto'（旧预设迁移规则，方案 §4.5）。
  // maxTokens 仅作为"模型输出硬上限"兼容值继续保留；缺省迁移为 0（自动）。
  preset.responseLengthHint = typeof raw.responseLengthHint === 'string'
    && VALID_RESPONSE_LENGTH_HINTS.has(raw.responseLengthHint)
    ? raw.responseLengthHint as ResponseLengthMode
    : 'auto'

  return preset
}

/**
 * Convert imported preset JSON into QingYu's native shape before normalization.
 * Native camelCase fields take precedence in mixed files; recognized snake_case
 * fields are mapped, while every unrecognized field is reported to the caller.
 */
export function normalizeImportedPreset(
  input: unknown,
  options: { id: string; fallbackName: string },
): PresetImportResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('预设格式无效')
  }

  const raw = input as Record<string, unknown>
  const converted: Record<string, unknown> = { ...raw }
  let mappedStandardField = false

  for (const [sourceField, targetField] of Object.entries(STANDARD_FIELD_MAP)) {
    if (!Object.prototype.hasOwnProperty.call(raw, sourceField)) continue
    mappedStandardField = true
    if (converted[targetField] === undefined) converted[targetField] = raw[sourceField]
  }

  const importedName = typeof raw.name === 'string' ? raw.name.trim() : ''
  converted.id = options.id
  converted.name = importedName || options.fallbackName.trim()
  converted.isBuiltin = false

  const recognizedFields = new Set([...NATIVE_PRESET_FIELDS, ...Object.keys(STANDARD_FIELD_MAP)])
  const unsupportedFields = Object.keys(raw)
    .filter((field) => !recognizedFields.has(field))
    .sort((a, b) => a.localeCompare(b))

  return {
    preset: normalizePreset(converted),
    sourceFormat: mappedStandardField ? 'standard' : 'qingyu',
    unsupportedFields,
  }
}
