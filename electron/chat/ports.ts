/* eslint-disable @typescript-eslint/no-unused-vars, @typescript-eslint/no-require-imports, no-empty */
/**
 * V12-06 Port 定义（实施方案 §5.2）
 * 测试替身与迁移边界，不引入复杂 DI 框架
 */
import type { TaskSnapshot, TaskEventEnvelope } from '../../shared/chat-core/events'
import type { ChatCommand } from '../../shared/chat-core/commands'

export interface MessageRef {
  id: string
  sessionId: string
  characterId: string
}

export interface PersistUserMessage {
  id: string
  sessionId: string
  characterId: string
  content: string
  images?: string[]
  replyToId?: string
  requestId: string
}

export interface PersistAssistantMessage {
  id: string
  sessionId: string
  characterId: string
  content: string
  images?: string[]
  requestId: string
  generationTaskId: string
}

export interface MessagePort {
  findSession(sessionId: string, characterId?: string): Promise<MessageRef | null>
  findByRequestId(sessionId: string, requestId: string): Promise<{ id: string } | null>
  findMessage(sessionId: string, messageId: string): Promise<{ id: string; role: string; content: string; swipes?: string[]; swipeIndex?: number } | null>
  appendUserMessage(input: PersistUserMessage): Promise<{ id: string }>
  commitAssistantMessage(input: PersistAssistantMessage): Promise<{ id: string }>
  updateAssistantMessage(messageId: string, patch: { content: string }): Promise<void>
  appendSwipedCandidate(messageId: string, content: string): Promise<{ id: string; content: string; swipes: string[]; swipeIndex: number }>
}

export interface BuildContextInput {
  sessionId: string
  characterId: string
  content: string
}

export interface PreparedContext {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  fingerprint: string
  model: { provider: string; model: string; profileId?: string }
}

export interface ContextPort {
  build(input: BuildContextInput): Promise<PreparedContext>
}

export interface ModelRequest {
  messages: PreparedContext['messages']
  model: string
  provider: string
}

export interface ModelCallbacks {
  onChunk(delta: string): void
  onUsage?(usage: { promptTokens: number; completionTokens: number; totalTokens: number }): void
}

export interface ModelResult {
  text: string
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
}

export interface ModelPort {
  stream(request: ModelRequest, callbacks: ModelCallbacks, signal: AbortSignal): Promise<ModelResult>
}

export interface ProposedToolCall {
  name: string
  args: Record<string, unknown>
}

export type ToolDecision = 'allow' | 'deny'

export interface ToolPermissionPort {
  authorize(call: ProposedToolCall, task: TaskSnapshot): Promise<ToolDecision>
}

export interface TaskRepository {
  create(task: TaskSnapshot): Promise<void>
  update(taskId: string, transition: (s: TaskSnapshot) => TaskSnapshot): Promise<TaskSnapshot>
  findByRequestId(requestId: string): Promise<TaskSnapshot | null>
  appendEvent(event: TaskEventEnvelope): Promise<void>
  readEvents(taskId: string, afterSequence: number): Promise<{ events: TaskEventEnvelope[] }>
}
