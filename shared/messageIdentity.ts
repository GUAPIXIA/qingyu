import type {
  MessageGenerationKind,
  MessageSpeakerKind,
  NarrativeMode,
} from './types'

export const MESSAGE_SPEAKER_KINDS = ['persona', 'narrator', 'character', 'system'] as const
export const MESSAGE_GENERATION_KINDS = [
  'manual',
  'input_continue',
  'assistant_reply',
  'regenerate',
  'message_continue',
] as const

export function isMessageSpeakerKind(value: unknown): value is MessageSpeakerKind {
  return typeof value === 'string' && (MESSAGE_SPEAKER_KINDS as readonly string[]).includes(value)
}

export function isMessageGenerationKind(value: unknown): value is MessageGenerationKind {
  return typeof value === 'string' && (MESSAGE_GENERATION_KINDS as readonly string[]).includes(value)
}

/**
 * 统一的显示身份回退规则。显式且合法的 speakerKind 优先；旧数据和非法值均安全回退。
 * role/characterId 只描述消息方向，不再直接等同于界面身份。
 */
export function resolveMessageSpeakerKind(input: {
  speakerKind?: unknown
  role?: unknown
  characterId?: unknown
  narrativeMode?: unknown
}): MessageSpeakerKind {
  if (isMessageSpeakerKind(input.speakerKind)) return input.speakerKind
  if (input.role === 'system') return 'system'
  const isUser = input.role === 'user' || input.characterId === '__user__'
  if (isUser) return input.narrativeMode === 'omniscient' ? 'narrator' : 'persona'
  return 'character'
}

export function defaultGenerationKind(input: {
  role?: unknown
  characterId?: unknown
}): MessageGenerationKind {
  return input.role === 'user' || input.role === 'system' || input.characterId === '__user__'
    ? 'manual'
    : 'assistant_reply'
}

export function resolveMessageGenerationKind(
  value: unknown,
  input: { role?: unknown; characterId?: unknown },
): MessageGenerationKind {
  return isMessageGenerationKind(value) ? value : defaultGenerationKind(input)
}

/** 为新落盘消息补齐稳定快照，同时过滤非法协议值。 */
export function withMessageIdentity<T extends {
  speakerKind?: unknown
  generationKind?: unknown
  role?: unknown
  characterId?: unknown
  narrativeMode?: NarrativeMode
}>(message: T): T & {
  speakerKind: MessageSpeakerKind
  generationKind: MessageGenerationKind
} {
  return {
    ...message,
    speakerKind: resolveMessageSpeakerKind(message),
    generationKind: resolveMessageGenerationKind(message.generationKind, message),
  }
}
