/**
 * V12-02 共享契约：ChatCommand（实施方案 §6）
 *
 * 客户端只提交命令，执行由主进程 ChatOrchestrator 完成。
 * swipe 在已有候选间切换时不是 AI 任务，不进入 Orchestrator。
 * translate 在 0.12 可继续走旧路径，0.12.1 再迁入 BackgroundTask。
 */

export interface ClientRef {
  kind: 'desktop' | 'android'
  clientId: string
  deviceId?: string
  protocolVersion: 1 | 2
}

/** 任务类型（与 ChatCommand.type 1:1） */
export type ChatCommandType = 'send' | 'regenerate' | 'continue' | 'retry_generation'

export type ChatCommand =
  | {
      type: 'send'
      requestId: string
      sessionId: string
      characterId?: string
      content: string
      images?: string[]
      replyToId?: string
      client: ClientRef
    }
  | {
      type: 'regenerate'
      requestId: string
      sessionId: string
      characterId?: string
      messageId: string
      client: ClientRef
    }
  | {
      type: 'continue'
      requestId: string
      sessionId: string
      characterId?: string
      client: ClientRef
    }
  | {
      type: 'retry_generation'
      requestId: string
      retryOfTaskId: string
      client: ClientRef
    }

/** 裸的桌面端命令（client 由主进程注入，不经 IPC 伪造） */
export type DesktopChatCommand = Omit<ChatCommand, 'client'> & { client?: Partial<ClientRef> }

/** 校验：requestId/sessionId 必填且为 safeId 形状 */
const SAFE_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/

export function isValidRequestId(v: unknown): boolean {
  return typeof v === 'string' && SAFE_ID_RE.test(v)
}

export function validateChatCommand(cmd: ChatCommand): string | null {
  if (!isValidRequestId(cmd.requestId)) return 'INVALID_COMMAND: requestId'
  if (cmd.type !== 'retry_generation') {
    if (typeof (cmd as { sessionId?: string }).sessionId !== 'string' || !(cmd as { sessionId: string }).sessionId.trim()) {
      return 'INVALID_COMMAND: sessionId'
    }
  }
  if (cmd.type === 'send' && !(cmd.content ?? '').trim() && !(cmd.images ?? []).length) {
    return 'INVALID_COMMAND: content/images'
  }
  if (cmd.type === 'regenerate' && !isValidRequestId((cmd as { messageId: string }).messageId)) {
    return 'INVALID_COMMAND: messageId'
  }
  if (cmd.type === 'retry_generation' && !isValidRequestId(cmd.retryOfTaskId)) {
    return 'INVALID_COMMAND: retryOfTaskId'
  }
  return null
}
