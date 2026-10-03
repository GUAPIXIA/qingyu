import { describe, expect, it, vi } from 'vitest'
import { applyCommandBatch, createEmptyRuntime, createWorldWithDefaults, type SpatialCommand } from '@qingyu/spatial-core'
import { EmbeddedCommandQueue, type EmbeddedSnapshot, type EmbeddedCommit } from '../src/embedded/commandQueue.ts'
import { useSpatialStore } from '../src/store/spatialStore.ts'

function setup() {
  const world = createWorldWithDefaults('world-test', '世界', { now: 1 })
  const snapshot: EmbeddedSnapshot = { world, runtime: createEmptyRuntime(world.id, 'runtime-test', 1),
    version: { worldId: world.id, runtimeId: 'runtime-test', bindingEpoch: 'epoch', runtimeRevision: 0, worldFingerprint: 'baseline' } }
  const send = vi.fn<(request: EmbeddedCommit) => void>()
  const sync = vi.fn()
  const status = vi.fn()
  let sequence = 0
  const queue = new EmbeddedCommandQueue(snapshot, { send, sync, status, id: () => `commit-${++sequence}` })
  return { queue, snapshot, send, sync, status }
}
const rename = (name: string): SpatialCommand[] => [{ type: 'update_world', patch: { name } }]
function apply(snapshot: EmbeddedSnapshot, request: EmbeddedCommit): EmbeddedSnapshot {
  const result = applyCommandBatch(snapshot, { schemaVersion: 1, expectedRevision: request.expectedRuntimeRevision, commands: request.commands },
    { now: 5, source: 'user' })
  if (!result.ok) throw new Error(result.message)
  return { ...result.state, version: { ...snapshot.version, runtimeRevision: result.state.runtime.revision, worldFingerprint: `fp-${result.state.runtime.revision}` } }
}

describe('PC 嵌入命令队列', () => {
  it('串行发送，确认后重放本地后续预览，flush 等待所有确认', async () => {
    const { queue, snapshot, send, sync } = setup()
    queue.enqueue(rename('一'))
    queue.enqueue(rename('二'))
    expect(send).toHaveBeenCalledTimes(1)
    let flushed = false
    const flush = queue.flush().then(() => { flushed = true })
    const first = send.mock.calls[0]![0]
    const committed = apply(snapshot, first)
    queue.confirm(first.commitId, { ok: true, snapshot: committed, receipt: { commitId: first.commitId, revisionAfter: 1, worldFingerprintAfter: 'fp-1' } })
    expect(sync.mock.calls[0]![0].world.name).toBe('二')
    expect(sync.mock.calls[0]![1]).toBe(false)
    expect(flushed).toBe(false)
    expect(send).toHaveBeenCalledTimes(2)
    const second = send.mock.calls[1]![0]
    expect(second.expectedRuntimeRevision).toBe(1)
    expect(second.expectedWorldFingerprint).toBe('fp-1')
    const final = apply(committed, second)
    queue.confirm(second.commitId, { ok: true, snapshot: final, receipt: { commitId: second.commitId, revisionAfter: 2, worldFingerprintAfter: 'fp-2' } })
    await flush
    expect(flushed).toBe(true)
  })

  it('外部更新不覆盖未提交预览，也不自动更新版本后重试', async () => {
    const { queue, snapshot, send, sync, status } = setup()
    queue.enqueue(rename('本地'))
    const original = send.mock.calls[0]![0]
    queue.external({ ...snapshot, version: { ...snapshot.version, worldFingerprint: 'external' } })
    expect(sync).not.toHaveBeenCalled()
    expect(status.mock.lastCall?.[1]).toContain('保留本地操作')
    queue.confirm(original.commitId, { ok: false, message: '版本冲突' })
    await expect(queue.flush()).rejects.toThrow('版本冲突')
    queue.retry()
    expect(send.mock.calls[1]![0]).toEqual(original)
  })

  it('无本地编辑时同步外部数据，有待提交时要显式重新载入', async () => {
    const { queue, snapshot, sync } = setup()
    const external = { ...snapshot, version: { ...snapshot.version, worldFingerprint: 'external' } }
    queue.external(external)
    expect(sync).toHaveBeenCalledWith(external, true)
    queue.enqueue(rename('未提交'))
    queue.reload(snapshot)
    await expect(queue.flush()).resolves.toBeUndefined()
    expect(sync).toHaveBeenLastCalledWith(snapshot, true)
  })

  it('外部冲突后最后一批收到确认，空队列重试不能误报已同步', async () => {
    const { queue, snapshot, send, sync, status } = setup()
    queue.enqueue(rename('本地'))
    const first = send.mock.calls[0]![0]
    queue.external({ ...snapshot, version: { ...snapshot.version, worldFingerprint: 'external' } })
    queue.confirm(first.commitId, { ok: true, snapshot: apply(snapshot, first),
      receipt: { commitId: first.commitId, revisionAfter: 1, worldFingerprintAfter: 'fp-1' } })
    queue.retry()
    expect(sync).not.toHaveBeenCalled()
    expect(status.mock.lastCall?.[1]).toContain('保留本地操作')
    await expect(queue.flush()).rejects.toThrow('保留本地操作')
  })

  it('丢失确认的重试返回更晚状态时，不自动回放剩余操作', async () => {
    const { queue, snapshot, send, sync } = setup()
    queue.enqueue(rename('第一批'))
    queue.enqueue(rename('旧第二批'))
    const first = send.mock.calls[0]![0]
    queue.confirm(first.commitId, { ok: true, snapshot: { ...snapshot, version: { ...snapshot.version, runtimeRevision: 3, worldFingerprint: 'later' } },
      receipt: { commitId: first.commitId, revisionAfter: 1, worldFingerprintAfter: 'fp-1' } })
    expect(send).toHaveBeenCalledTimes(1)
    expect(sync).not.toHaveBeenCalled()
    await expect(queue.flush()).rejects.toThrow('保留本地操作')
  })

  it('权威确认不整理布局、不重置视口、选中对象或自身撤销历史', () => {
    const { snapshot } = setup()
    const store = useSpatialStore.getState()
    store.syncAuthoritative(snapshot, true, true)
    store.setWorldName('本地更名')
    const edited = useSpatialStore.getState()
    const node = edited.core.world.nodes[0]!
    edited.select({ type: 'node', id: node.id })
    const fit = edited.fitViewRequest
    const history = edited.history
    edited.syncAuthoritative(edited.core, false)
    expect(useSpatialStore.getState().fitViewRequest).toBe(fit)
    expect(useSpatialStore.getState().selection.id).toBe(node.id)
    expect(useSpatialStore.getState().history).toBe(history)
    useSpatialStore.getState().undo()
    expect(useSpatialStore.getState().core.world.name).toBe('世界')
    useSpatialStore.getState().redo()
    expect(useSpatialStore.getState().core.world.name).toBe('本地更名')
  })
})
