/* eslint-disable @typescript-eslint/no-unused-vars */
/**
 * V12-06 Port 定义（实施方案 §5.2）
 * 测试替身与迁移边界，不引入复杂 DI 框架
 */
import type { TaskSnapshot, TaskEventEnvelope } from '../../shared/chat-core/events'
import type { ChatCommand } from '../../shared/chat-core/commands'
import type { MessageGenerationKind, MessageSpeakerKind, NarrativeMode } from '../../shared/types'

export interface MessageRef {
  id: string
  sessionId: string
  characterId: string
  narrativeMode?: NarrativeMode
  speakerKind?: MessageSpeakerKind
  generationKind?: MessageGenerationKind
}

export interface PersistUserMessage {
  id: string
  sessionId: string
  characterId: string
  content: string
  images?: string[]
  replyToId?: string
  requestId: string
  narrativeMode?: NarrativeMode
  speakerKind: MessageSpeakerKind
  generationKind: MessageGenerationKind
}

export interface PersistAssistantMessage {
  id: string
  sessionId: string
  characterId: string
  content: string
  images?: string[]
  requestId: string
  generationTaskId: string
  narrativeMode?: NarrativeMode
  speakerKind: MessageSpeakerKind
  generationKind: MessageGenerationKind
  /** 阶段5：语义分块渲染标记（unified 管线新正文） */
  contentRenderMode?: 'markdown' | 'blocks'
}

export interface MessagePort {
  findSession(sessionId: string, characterId?: string): Promise<MessageRef | null>
  findByRequestId(sessionId: string, requestId: string): Promise<{ id: string } | null>
  findMessage(sessionId: string, messageId: string): Promise<{ id: string; role: string; content: string; swipes?: string[]; swipeIndex?: number } | null>
  appendUserMessage(input: PersistUserMessage): Promise<{ id: string }>
  commitAssistantMessage(input: PersistAssistantMessage): Promise<{ id: string }>
  updateAssistantMessage(messageId: string, patch: { content: string }): Promise<void>
  appendSwipedCandidate(messageId: string, content: string, generationKind?: MessageGenerationKind): Promise<{ id: string; content: string; swipes: string[]; swipeIndex: number }>
}

export interface BuildContextInput {
  sessionId: string
  characterId: string
  content: string
}

export interface PreparedContext {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  fingerprint: string
  requestMaxTokens: number
  /** 进程内使用（含 apiKey）；落盘/外发前必须经 {@link toPublicModelDescriptor} 剥离 */
  model: { provider: string; model: string; profileId?: string; apiKey?: string; baseUrl?: string }
}

/**
 * 任务记录与事件外发用的模型描述：**必须剥离 apiKey 与完整 baseUrl**。
 *
 * 2026-09-13 修复：任务快照会写入 `data/tasks` 下的 `task-*.json`，`task:started` 事件还会经 WS
 * 下发给桥接客户端——此前两处都直接透传 `ctx.model`，等于把明文 API Key 落盘（实测 84 个任务
 * 记录含明文 key）并广播给已配对设备。这里统一收窄为 `TaskSnapshot.model` 的形状。
 */
export function toPublicModelDescriptor(
  model: PreparedContext['model'],
): { provider: string; model: string; profileId?: string } {
  return {
    provider: model.provider,
    model: model.model,
    ...(model.profileId ? { profileId: model.profileId } : {}),
  }
}

export interface ContextPort {
  build(input: BuildContextInput): Promise<PreparedContext>
}

export interface ModelRequest {
  messages: PreparedContext['messages']
  model: string
  provider: string
  maxTokens: number
  apiKey?: string
  baseUrl?: string
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

/**
 * 回复落盘后的后台记忆调度端口。实现必须自行吞掉异步失败，不能阻塞或反转主对话任务终态。
 */
export interface MemorySchedulerPort {
  schedule(input: { sessionId: string; characterId: string }): void
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
