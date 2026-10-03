/**
 * 撤销 / 重做：保存领域命令及其逆命令，不保存鼠标移动帧。
 * 自动剧情命令作为单独事务，可整体撤销。
 */
import type { SpatialCommand } from './commands.ts'
import type { PlacementSource } from './model.ts'
import {
  applyCommandBatch,
  type ApplyBatchResult,
  type ApplyOptions,
  type SpatialCoreState,
} from './reducer.ts'

export interface HistoryEntry {
  label: string
  source: PlacementSource
  /** 正向命令（按执行顺序） */
  forward: SpatialCommand[]
  /** 逆命令（apply 返回的顺序；undo 时 reverse 后执行） */
  inverse: SpatialCommand[]
  revisionBefore: number
  revisionAfter: number
  at: number
}

export interface HistoryState {
  undoStack: HistoryEntry[]
  redoStack: HistoryEntry[]
  /** 超出后丢弃最旧的 undo 条目 */
  limit: number
}

export function createHistory(limit = 100): HistoryState {
  return { undoStack: [], redoStack: [], limit }
}

export interface RunResult {
  batch: ApplyBatchResult
  history: HistoryState
}

/**
 * 执行一批命令并压入 undo 栈。失败时历史不变。
 */
export function runBatch(
  state: SpatialCoreState,
  history: HistoryState,
  batch: Parameters<typeof applyCommandBatch>[1],
  options: ApplyOptions & { label?: string }
): RunResult {
  const result = applyCommandBatch(state, batch, options)
  if (!result.ok) {
    return { batch: result, history }
  }

  const entry: HistoryEntry = {
    label: options.label ?? batch.commands.map((c) => c.type).join('+'),
    source: options.source,
    forward: batch.commands,
    inverse: result.inverse,
    revisionBefore: state.runtime.revision,
    revisionAfter: result.state.runtime.revision,
    at: options.now,
  }

  const undoStack = [...history.undoStack, entry]
  while (undoStack.length > history.limit) undoStack.shift()

  return {
    batch: result,
    history: { ...history, undoStack, redoStack: [] },
  }
}

export function canUndo(history: HistoryState): boolean {
  return history.undoStack.length > 0
}

export function canRedo(history: HistoryState): boolean {
  return history.redoStack.length > 0
}

/**
 * 撤销最近一批。逆命令整批原子提交。
 * expectedRevision 使用当前 runtime.revision（撤销本身也是新版本）。
 */
export function undo(
  state: SpatialCoreState,
  history: HistoryState,
  options: { now: number; idGen?: () => string }
): RunResult {
  if (history.undoStack.length === 0) {
    return {
      batch: {
        ok: false,
        code: 'batch_empty',
        message: '无可撤销操作',
        commandIndex: -1,
      },
      history,
    }
  }
  const entry = history.undoStack[history.undoStack.length - 1]
  // 逆命令按执行时的逆序应用
  const commands = [...entry.inverse].reverse()
  const result = applyCommandBatch(
    state,
    {
      schemaVersion: 1,
      expectedRevision: state.runtime.revision,
      commands,
    },
    {
      now: options.now,
      source: 'system',
      idGen: options.idGen,
    }
  )
  if (!result.ok) {
    return { batch: result, history }
  }
  return {
    batch: result,
    history: {
      ...history,
      undoStack: history.undoStack.slice(0, -1),
      redoStack: [...history.redoStack, entry],
    },
  }
}

export function redo(
  state: SpatialCoreState,
  history: HistoryState,
  options: { now: number; idGen?: () => string }
): RunResult {
  if (history.redoStack.length === 0) {
    return {
      batch: {
        ok: false,
        code: 'batch_empty',
        message: '无可重做操作',
        commandIndex: -1,
      },
      history,
    }
  }
  const entry = history.redoStack[history.redoStack.length - 1]
  const result = applyCommandBatch(
    state,
    {
      schemaVersion: 1,
      expectedRevision: state.runtime.revision,
      commands: entry.forward,
    },
    {
      now: options.now,
      source: entry.source,
      idGen: options.idGen,
    }
  )
  if (!result.ok) {
    return { batch: result, history }
  }
  return {
    batch: result,
    history: {
      ...history,
      undoStack: [...history.undoStack, entry],
      redoStack: history.redoStack.slice(0, -1),
    },
  }
}
