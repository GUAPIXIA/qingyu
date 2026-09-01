import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { listCharacters } from '../../services/charCard'
import { chatData } from '../../ipc/chat'
import { DIRS, readJson } from '../../services/storage'
import { getDefaultSettings } from '../../../shared/defaults'
import { buildSettingsSnapshot } from '../settingsSync'
import { API_VERSION, SERVER_CAPABILITIES } from '../protocol'
import { getServerId } from '../identity'
import { findSessionByCharacterId, findSessionById, listAllSessions } from '../sessionsIndex'
import type { Message, Settings } from '../../../shared/types'
import type { BridgeChatService } from '../chatService'
import type { GenerationRegistry } from './generationRegistry'

export interface MobileRequestContext { requestId: string; sourceDeviceId?: string }
export interface ListMessagesInput { sessionId: string; characterId?: string; limit?: number; beforeId?: string }
export interface SendMessageInput { sessionId: string; content: string; replyToId?: string; images?: string[] }
export interface SwipeInput { sessionId: string; messageId: string; direction: number }
export interface TranslateInput { sessionId: string; messageId: string }

export interface MobileFacade {
  serverInfo(): Promise<Record<string, unknown>>
  listCharacters(): Promise<Record<string, unknown>[]>
  listSessions(): Promise<Record<string, unknown>[]>
  listMessages(input: ListMessagesInput): Promise<{ messages: Record<string, unknown>[]; nextCursor: string | null }>
  sendMessage(input: SendMessageInput, context: MobileRequestContext): Promise<Record<string, unknown>>
  swipe(input: SwipeInput, context: MobileRequestContext): Promise<Record<string, unknown>>
  translate(input: TranslateInput, context: MobileRequestContext): Promise<{ messageId: string; translation: string }>
  settingsSnapshot(): Promise<ReturnType<typeof buildSettingsSnapshot>>
  stop(requestId: string, context: MobileRequestContext): Promise<void>
}

function messageDto(message: Message): Record<string, unknown> {
  return {
    id: message.id, sessionId: message.sessionId, characterId: message.characterId,
    role: message.role, content: message.content,
    images: (message.images ?? []).map((image, index) => image.startsWith('http')
      ? image : `/static/messages/${message.characterId}/${message.sessionId}/${message.id}/${index}`),
    timestamp: message.timestamp, translation: message.translation ?? null,
    swipes: message.swipes ?? null, swipeIndex: message.swipeIndex ?? null,
    replyToId: message.replyToId ?? null,
    usage: message.charUsage ? { promptTokens: 0, completionTokens: 0, totalTokens: 0 } : null,
  }
}

export class DefaultMobileFacade implements MobileFacade {
  constructor(
    private readonly chatService: BridgeChatService,
    private readonly generations: GenerationRegistry,
  ) {}

  async serverInfo() {
    return { apiVersion: API_VERSION, appVersion: app.getVersion(), serverId: getServerId(), capabilities: [...SERVER_CAPABILITIES] }
  }

  async listCharacters() {
    return (await listCharacters()).map((character) => ({
      id: character.id, name: character.name,
      avatarUrl: existsSync(join(DIRS.characters(), `${character.id}.png`)) ? `/static/avatars/${character.id}` : null,
      coverUrl: existsSync(join(DIRS.characters(), `${character.id}_cover.png`)) ? `/static/covers/${character.id}` : null,
      description: character.description, personality: character.personality, scenario: character.scenario,
      firstMessage: character.firstMessage, alternateGreetings: character.alternateGreetings ?? [], tags: character.tags ?? [],
      pinned: character.pinned ?? false, creator: character.creator ?? '', createdAt: character.createdAt ?? 0,
      updatedAt: character.updatedAt ?? 0, translatedContent: character.translatedContent ?? undefined,
    }))
  }

  async listSessions() {
    const [sessions, characters] = await Promise.all([listAllSessions(), listCharacters()])
    const names = new Map(characters.map((character) => [character.id, character.name]))
    return sessions.map((session) => ({
      id: session.id, characterId: session.characterId, characterName: names.get(session.characterId) ?? '',
      title: session.title, createdAt: session.createdAt, updatedAt: session.updatedAt,
      personaId: session.personaId ?? null, messageCount: session.messageCount, lastMessage: session.lastMessage,
    }))
  }

  async listMessages(input: ListMessagesInput) {
    const session = input.characterId
      ? await findSessionByCharacterId(input.characterId, input.sessionId)
      : await findSessionById(input.sessionId)
    if (!session) throw new Error('会话不存在')
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100)
    const sorted = [...chatData.readMessages(session.characterId, input.sessionId)].sort((a, b) => b.timestamp - a.timestamp)
    const cursor = input.beforeId ? sorted.findIndex((message) => message.id === input.beforeId) : -1
    const start = cursor >= 0 ? cursor + 1 : 0
    const page = sorted.slice(start, start + limit)
    return { messages: page.map(messageDto), nextCursor: start + limit < sorted.length ? page.at(-1)?.id ?? null : null }
  }

  async sendMessage(input: SendMessageInput, context: MobileRequestContext) {
    return messageDto(await this.chatService.sendMessage(
      input.sessionId, context.requestId, input.content, input.replyToId, input.images,
    ))
  }

  async swipe(input: SwipeInput) {
    return messageDto(await this.chatService.swipe(input.sessionId, input.messageId, input.direction))
  }

  async translate(input: TranslateInput) {
    return this.chatService.translate(input.sessionId, input.messageId)
  }

  async settingsSnapshot() {
    const settings = readJson<Settings>(join(DIRS.config(), 'settings.json'), 'settings') ?? getDefaultSettings()
    return buildSettingsSnapshot(settings)
  }

  async stop(requestId: string) { this.generations.cancel(requestId) }
}
