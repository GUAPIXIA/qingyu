/**
 * 对话方向 → 输入框的草稿桥。
 *
 * 方向卡片渲染在消息列表中，而草稿文本属于输入框组件的局部状态；
 * 两者没有父子关系。这里用模块级注册表替代事件广播：
 * - 输入框挂载时注册“读取/写入”能力；
 * - 方向卡片读取当前草稿决定是否需要确认，再写入。
 *
 * 单聊与群聊各自注册一个作用域，避免两个输入框同时挂载时互相覆盖。
 * 只在渲染进程内使用，不持久化。
 */

export type DraftScope = 'single' | 'group'

export interface DraftBridge {
  /** 当前草稿原文。 */
  getText: () => string
  /** 写入草稿；来源为方向卡片，写入后即视为用户可编辑的手动草稿。 */
  setDraft: (text: string) => void
}

const bridges = new Map<DraftScope, DraftBridge>()

export function registerDraftBridge(scope: DraftScope, next: DraftBridge | null): void {
  if (next) bridges.set(scope, next)
  else bridges.delete(scope)
}

export function getDraftText(scope: DraftScope): string {
  return bridges.get(scope)?.getText() ?? ''
}

/** 将方向内容写入输入框；返回是否成功（输入框未挂载时失败）。 */
export function applyDirectionToDraft(scope: DraftScope, content: string): boolean {
  const bridge = bridges.get(scope)
  if (!bridge) return false
  bridge.setDraft(content)
  return true
}
