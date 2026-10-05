// 阶段 3B 自测：事件型异步等待器（方案 §6.2）。
// 纯逻辑用例：用假的任务快照序列驱动，不启动 Electron、不调用模型。
import { describe, expect, it } from 'vitest'
import {
  TERMINAL_TASK_STATES,
  isTerminalTaskState,
  resolveTaskId,
  statusForTaskState,
  waitForTask,
} from '../lib/async-wait.mjs'

function sequenceFetcher(snapshots) {
  let index = 0
  const calls = []
  return {
    calls,
    fetchTask: async (taskId) => {
      calls.push(taskId)
      const snapshot = snapshots[Math.min(index, snapshots.length - 1)]
      index += 1
      return snapshot
    },
  }
}

describe('任务状态语义', () => {
  it('终止态集合与产品一致', () => {
    expect([...TERMINAL_TASK_STATES].sort()).toEqual(['cancelled', 'completed', 'failed', 'interrupted'])
    expect(isTerminalTaskState('completed')).toBe(true)
    expect(isTerminalTaskState('running')).toBe(false)
    expect(isTerminalTaskState('accepted')).toBe(false)
  })

  it('任务状态映射到动作状态', () => {
    expect(statusForTaskState('completed')).toBe('succeeded')
    expect(statusForTaskState('failed')).toBe('failed')
    expect(statusForTaskState('cancelled')).toBe('cancelled')
    expect(statusForTaskState('interrupted')).toBe('unknown')
    expect(statusForTaskState('running')).toBe('running')
  })
})

describe('等待任务终态', () => {
  it('轮询到 completed 后返回快照与轮询次数', async () => {
    const { fetchTask, calls } = sequenceFetcher([
      { state: 'running', lastSequence: 1 },
      { state: 'running', lastSequence: 2 },
      { state: 'completed', lastSequence: 3, accumulatedText: 'done' },
    ])
    const seen = []
    const result = await waitForTask({ taskId: 't1', fetchTask, pollMs: 1, onProgress: (snapshot) => seen.push(snapshot.state) })
    expect(result.outcome).toBe('completed')
    expect(result.polls).toBe(3)
    expect(result.snapshot.accumulatedText).toBe('done')
    expect(seen).toEqual(['running', 'running', 'completed'])
    expect(calls).toEqual(['t1', 't1', 't1'])
  })

  it('failed / cancelled / interrupted 分别映射', async () => {
    for (const [state, expected] of [['failed', 'failed'], ['cancelled', 'cancelled'], ['interrupted', 'interrupted']]) {
      const { fetchTask } = sequenceFetcher([{ state }])
      const result = await waitForTask({ taskId: 't', fetchTask, pollMs: 1 })
      expect(result.outcome).toBe(expected)
    }
  })

  it('瞬时查不到不算失败，连续 3 次才判 not_found', async () => {
    const transient = sequenceFetcher([null, { state: 'running' }, { state: 'completed' }])
    const recovered = await waitForTask({ taskId: 't', fetchTask: transient.fetchTask, pollMs: 1 })
    expect(recovered.outcome).toBe('completed')

    const missing = sequenceFetcher([null])
    const result = await waitForTask({ taskId: 'ghost', fetchTask: missing.fetchTask, pollMs: 1 })
    expect(result.outcome).toBe('not_found')
    expect(result.polls).toBe(3)
  })

  it('超时后调用取消并返回 timeout（末次快照若已终结则采用）', async () => {
    let cancelled = 0
    const { fetchTask } = sequenceFetcher([{ state: 'running' }])
    const timeout = await waitForTask({
      taskId: 't',
      fetchTask,
      timeoutMs: 20,
      pollMs: 5,
      cancel: async () => { cancelled += 1 },
    })
    expect(timeout.outcome).toBe('timeout')
    expect(cancelled).toBe(1)

    let index = 0
    const late = async () => {
      index += 1
      return index < 3 ? { state: 'running' } : { state: 'completed' }
    }
    const settled = await waitForTask({ taskId: 't', fetchTask: late, timeoutMs: 15, pollMs: 5 })
    expect(['timeout', 'completed']).toContain(settled.outcome)
  })

  it('fetchTask 抛错不会中断等待（按未就绪处理）', async () => {
    let calls = 0
    const fetchTask = async () => {
      calls += 1
      if (calls === 1) throw new Error('boom')
      return { state: 'completed' }
    }
    const result = await waitForTask({ taskId: 't', fetchTask, pollMs: 1 })
    expect(result.outcome).toBe('completed')
  })
})

describe('任务 id 提取', () => {
  it('按路径取字符串 id', () => {
    expect(resolveTaskId({ taskId: 'a' })).toBe('a')
    expect(resolveTaskId({ task: { taskId: 'b' } }, 'task.taskId')).toBe('b')
    expect(resolveTaskId({ taskId: '' })).toBeNull()
    expect(resolveTaskId({ taskId: 123 })).toBeNull()
    expect(resolveTaskId(null)).toBeNull()
  })
})
