import type { Preset } from './types'

const VALID_EXAMPLE_MODES = new Set(['always', 'first_turn', 'off'])

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
    maxTokens: Math.round(finiteNumber(raw.maxTokens, 1024, 1, 262_144)),
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

  return preset
}
