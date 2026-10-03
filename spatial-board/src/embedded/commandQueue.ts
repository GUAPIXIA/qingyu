import { applyCommandBatch, type SpatialCommand, type SpatialCoreState } from '@qingyu/spatial-core'

/** 独立包的桥接协议；与 PC shared/spatial.ts 的线格式一致。 */
export interface EmbeddedSnapshot extends SpatialCoreState {
  version: { worldId: string; runtimeId: string; bindingEpoch: string; runtimeRevision: number; worldFingerprint: string }
}
export interface EmbeddedCommit {
  commitId: string
  worldId: string
  runtimeId: string
  bindingEpoch: string
  expectedRuntimeRevision: number
  expectedWorldFingerprint: string
  commands: SpatialCommand[]
}
export type EmbeddedResult =
  | { ok: true; snapshot: EmbeddedSnapshot; receipt: { commitId: string; revisionAfter: number; worldFingerprintAfter: string } }
  | { ok: false; message: string; snapshot?: EmbeddedSnapshot }

/** 一次只发一批；只有自己的确认可以推进后续命令的基线。 */
export class EmbeddedCommandQueue {
  private pending: Array<{ commitId: string; commands: SpatialCommand[]; request?: EmbeddedCommit }> = []
  private inFlight = false
  private error: string | null = null
  private waiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = []

  constructor(private authority: EmbeddedSnapshot, private readonly hooks: {
    send: (request: EmbeddedCommit) => void
    sync: (core: SpatialCoreState, resetHistory: boolean) => void
    status: (pending: number, error: string | null) => void
    id: () => string
  }) {}

  enqueue(commands: SpatialCommand[]): void {
    this.pending.push({ commitId: this.hooks.id(), commands: structuredClone(commands) })
    this.changed()
    this.pump()
  }

  private changed(): void {
    this.hooks.status(this.pending.length, this.error)
    if (this.error || this.pending.length === 0) {
      for (const waiter of this.waiters.splice(0)) {
        if (this.error) waiter.reject(new Error(this.error))
        else waiter.resolve()
      }
    }
  }

  private pump(): void {
    if (this.inFlight || this.error || !this.pending.length) return
    const head = this.pending[0]!
    const version = this.authority.version
    head.request ??= { commitId: head.commitId, commands: head.commands, worldId: version.worldId,
      runtimeId: version.runtimeId, bindingEpoch: version.bindingEpoch,
      expectedRuntimeRevision: version.runtimeRevision, expectedWorldFingerprint: version.worldFingerprint }
    this.inFlight = true
    this.hooks.send(head.request)
  }

  confirm(commitId: string, result: EmbeddedResult): void {
    if (this.pending[0]?.commitId !== commitId) return
    this.inFlight = false
    if (!result.ok) {
      this.error = result.message
      this.changed()
      return
    }
    this.pending.shift()
    if (result.snapshot.version.runtimeRevision !== result.receipt.revisionAfter ||
      result.snapshot.version.worldFingerprint !== result.receipt.worldFingerprintAfter) {
      // 丢失确认后的幂等重试可能返回更晚的状态，不能据此回放旧的后续操作。
      this.external(result.snapshot)
      this.changed()
      return
    }
    if (this.error) { this.changed(); return }
    this.authority = result.snapshot
    let core: SpatialCoreState = result.snapshot
    for (const next of this.pending) {
      const applied = applyCommandBatch(core, { schemaVersion: 1, expectedRevision: core.runtime.revision, commands: next.commands },
        { now: Date.now(), source: 'user', idGen: this.hooks.id })
      if (!applied.ok) { this.error = `待提交操作需要核对：${applied.message}`; this.changed(); return }
      core = applied.state
    }
    this.hooks.sync(core, false)
    this.changed()
    this.pump()
  }

  external(snapshot: EmbeddedSnapshot): void {
    const old = this.authority.version
    const next = snapshot.version
    if (old.worldId === next.worldId && old.runtimeId === next.runtimeId && old.bindingEpoch === next.bindingEpoch &&
      old.runtimeRevision === next.runtimeRevision && old.worldFingerprint === next.worldFingerprint) return
    if (this.pending.length) {
      this.error = '画板在其他位置更新，已保留本地操作，请核对最新画板'
      this.changed()
      return
    }
    this.authority = snapshot
    this.error = null
    this.hooks.sync(snapshot, true)
    this.changed()
  }

  retry(): void {
    if (this.inFlight || !this.pending.length) return
    this.error = null
    this.changed()
    this.pump() // 保留原提交 ID 与版本，不偷偷换成最新版本。
  }

  pause(): void { this.error = '正在核对最新画板'; this.changed() }

  reload(snapshot: EmbeddedSnapshot): void {
    this.pending = []
    this.inFlight = false
    this.error = null
    this.authority = snapshot
    this.hooks.sync(snapshot, true)
    this.changed()
  }

  flush(): Promise<void> {
    if (this.error) return Promise.reject(new Error(this.error))
    if (!this.pending.length) return Promise.resolve()
    return new Promise((resolve, reject) => { this.waiters.push({ resolve, reject }) })
  }
}
