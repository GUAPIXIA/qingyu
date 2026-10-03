import { nanoid } from 'nanoid'
import type { ChatParams } from '../../shared/types'
import type { GenerationTask } from '../../shared/generationTaskBudget'
import { stripAllThinking } from '../../shared/thoughtMarkup'
import { featureFingerprint, type EditorOwner } from '../../shared/featureSource'
import { abortFeatureTask, beginFeatureTask, finishFeatureTask, requestFeatureText, type FeatureTask } from './featureTasks'

export interface EditorTicket { task: FeatureTask; objectId: string; revision: number; operation: GenerationTask }
export interface EditorSuggestion { taskId: string; objectId: string; label: string; content: string }

/** 每次编辑（包括改后改回）推进版本；网络结果仅可提交到发起时的对象和版本。 */
export class EditorAssistant {
  private readonly instanceId = nanoid()
  private revision = 0
  private tasks = new Set<FeatureTask>()
  private disposed = false
  readonly suggestions: EditorSuggestion[] = []
  constructor(readonly editor: string, private objectId: string) {}
  syncObject(objectId: string): void {
    if (this.objectId === objectId) return
    this.cancel(); this.objectId = objectId; this.touch()
  }
  touch(): void { this.revision++ }
  begin(operation: GenerationTask, material: unknown): EditorTicket {
    if (this.disposed) throw new Error('编辑器已关闭')
    // 一个编辑器的新操作替换旧操作；提前登记，预算查询期间也可取消。
    this.cancel()
    const owner: EditorOwner = { kind: 'editor', editor: this.editor, objectId: this.objectId, instanceId: this.instanceId }
    const task = beginFeatureTask(owner, 'editing', {
      messages: [], mode: 'whole', artifactKey: featureFingerprint([operation, material]), session: { revision: this.revision },
    }, undefined, operation)!
    this.tasks.add(task)
    return { task, objectId: this.objectId, revision: this.revision, operation }
  }
  owns(ticket: EditorTicket): boolean {
    return !this.disposed && ticket.objectId === this.objectId && !ticket.task.controller.signal.aborted
  }
  current(ticket: EditorTicket): boolean { return this.owns(ticket) && ticket.revision === this.revision }
  async request(ticket: EditorTicket, params: ChatParams, progress?: (text: string) => void): Promise<string> {
    const result = await requestFeatureText(ticket.task, { ...params, observability: {
      ...params.observability, source: 'aux', taskType: params.observability?.taskType ?? ticket.operation,
    } }, progress)
    if (ticket.task.controller.signal.aborted || result.completion.finishReason !== 'stop') {
      ticket.task.status = ticket.task.controller.signal.aborted ? 'cancelled' : 'failed'
      throw new Error('生成已中断或未完成，请重试')
    }
    return stripAllThinking(result.text)
  }
  keep(ticket: EditorTicket, content: string, label: string): void {
    if (!this.owns(ticket) || !content.trim()) return
    this.suggestions.push({ taskId: ticket.task.id, objectId: ticket.objectId, label, content })
    if (this.suggestions.length > 10) this.suggestions.splice(0, this.suggestions.length - 10)
  }
  finish(ticket: EditorTicket): void { this.tasks.delete(ticket.task); finishFeatureTask(ticket.task) }
  cancel(): void { for (const task of this.tasks) abortFeatureTask(task); this.tasks.clear() }
  dispose(): void { this.cancel(); this.disposed = true }
  activate(): void { this.disposed = false }
}
