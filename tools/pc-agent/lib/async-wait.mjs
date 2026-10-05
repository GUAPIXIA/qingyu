// 事件型异步等待（方案 §6.2）：触发前绑定、按 task/request ID 过滤、等待终态、支持取消与超时。
//
// 现状说明：产品提供的是任务模型（chatTask.start/get/eventsAfter/cancel），
// 比裸事件更可靠——先拿到 taskId，再轮询快照直到终态，事件只用于进度与归属核对。
// 终止态集合与 shared/chat-core/events.ts 的 TERMINAL_STATES 保持一致。

export const TERMINAL_TASK_STATES = ['completed', 'failed', 'cancelled', 'interrupted']

/** 任务状态 → 动作状态（方案 §5.4 的动作状态集合） */
const STATUS_BY_TASK_STATE = {
  completed: 'succeeded',
  failed: 'failed',
  cancelled: 'cancelled',
  interrupted: 'unknown',
}

export function isTerminalTaskState(state) {
  return TERMINAL_TASK_STATES.includes(state)
}

export function statusForTaskState(state) {
  return STATUS_BY_TASK_STATE[state] ?? 'running'
}

/**
 * 轮询任务快照直到终态。
 * @param {object} input
 * @param {string} input.taskId
 * @param {(taskId: string) => Promise<object|null>} input.fetchTask 返回快照；null 表示查不到
 * @param {number} [input.timeoutMs] 默认 120s
 * @param {number} [input.pollMs] 默认 500ms
 * @param {(snapshot: object) => void} [input.onProgress] 每次取到快照时回调
 * @param {() => Promise<void>} [input.cancel] 超时/外部请求时调用（可选）
 * @returns {Promise<{outcome: string, snapshot: object|null, polls: number, elapsedMs: number}>}
 *   outcome ∈ completed | failed | cancelled | interrupted | not_found | timeout
 */
export async function waitForTask({
  taskId,
  fetchTask,
  timeoutMs = 120000,
  pollMs = 500,
  onProgress = () => {},
  cancel = null,
}) {
  const started = Date.now()
  let polls = 0
  let consecutiveNotFound = 0

  while (Date.now() - started < timeoutMs) {
    polls += 1
    const snapshot = await fetchTask(taskId).catch(() => null)
    if (!snapshot) {
      // 刚提交时快照可能还没落盘；连续查不到才判定 not_found（不把瞬时缺失当失败）
      consecutiveNotFound += 1
      if (consecutiveNotFound >= 3) {
        return { outcome: 'not_found', snapshot: null, polls, elapsedMs: Date.now() - started }
      }
    } else {
      consecutiveNotFound = 0
      onProgress(snapshot)
      if (isTerminalTaskState(snapshot.state)) {
        return { outcome: snapshot.state, snapshot, polls, elapsedMs: Date.now() - started }
      }
    }
    await new Promise((done) => setTimeout(done, pollMs))
  }

  if (cancel) await cancel().catch(() => {})
  const last = await fetchTask(taskId).catch(() => null)
  if (last && isTerminalTaskState(last.state)) {
    return { outcome: last.state, snapshot: last, polls, elapsedMs: Date.now() - started }
  }
  return { outcome: 'timeout', snapshot: last, polls, elapsedMs: Date.now() - started }
}

/** 从动作结果里取任务 id（如 chatTask.start 返回 { taskId }） */
export function resolveTaskId(result, path = 'taskId') {
  if (!result || typeof result !== 'object') return null
  const segments = String(path).split('.')
  let current = result
  for (const segment of segments) {
    if (current === null || current === undefined) return null
    current = current[segment]
  }
  return typeof current === 'string' && current ? current : null
}
