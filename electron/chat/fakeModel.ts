/**
 * V12-06 FakeModelPort（供单测与 Orchestrator 骨架联调）
 * 支持：多批 chunk / 首包前失败 / 流中失败 / 超时
 */
import type { ModelPort, ModelRequest, ModelCallbacks, ModelResult } from './ports'

export type FakeBehavior =
  | { kind: 'success'; chunks: string[]; usage?: ModelResult['usage']; delayMs?: number }
  | { kind: 'fail_before'; error: string }
  | { kind: 'fail_mid'; chunks: string[]; error: string; delayMs?: number }
  | { kind: 'timeout'; delayMs: number }

export class FakeModelPort implements ModelPort {
  constructor(private behavior: FakeBehavior) {}

  setBehavior(b: FakeBehavior): void {
    this.behavior = b
  }

  async stream(request: ModelRequest, callbacks: ModelCallbacks, signal: AbortSignal): Promise<ModelResult> {
    const b = this.behavior

    if (b.kind === 'fail_before') {
      throw new Error(b.error)
    }

    if (b.kind === 'timeout') {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, b.delayMs)
        signal.addEventListener('abort', () => {
          clearTimeout(t)
          reject(new Error('Aborted'))
        })
      })
      throw new Error('timeout')
    }

    const chunks = b.kind === 'success' ? b.chunks : b.kind === 'fail_mid' ? b.chunks : []
    let text = ''

    for (const delta of chunks) {
      if (signal.aborted) throw new Error('Aborted')
      if (b.delayMs) await new Promise((r) => setTimeout(r, b.delayMs))
      if (signal.aborted) throw new Error('Aborted')
      text += delta
      callbacks.onChunk(delta)
    }

    if (b.kind === 'fail_mid') {
      throw new Error(b.error)
    }

    if (b.kind === 'success' && b.usage) {
      callbacks.onUsage?.(b.usage)
    }

    return { text, usage: b.kind === 'success' ? b.usage : undefined }
  }
}
