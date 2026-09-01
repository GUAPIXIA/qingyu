import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import type { LocalEmbeddingModelManifest } from '../../../shared/localModels'

interface PendingCall {
  resolve: (vectors: number[][]) => void
  reject: (error: Error) => void
}

export class LocalEmbeddingRuntime {
  private worker: Worker | null = null
  private nextId = 1
  private readonly pending = new Map<number, PendingCall>()
  private readonly queue: Array<{ id: number; priority: number; payload: Record<string, unknown> }> = []
  private activeId: number | null = null

  private getWorker(): Worker {
    if (this.worker) return this.worker
    const runtimeDirectory = typeof __dirname !== 'undefined' ? __dirname : process.cwd()
    const bundled = join(runtimeDirectory, 'localEmbeddingWorker.cjs')
    const development = join(process.cwd(), 'dist-electron', 'localEmbeddingWorker.cjs')
    const worker = new Worker(existsSync(bundled) ? bundled : development)
    worker.on('message', (message: { id: number; ok: boolean; result?: number[][]; error?: string }) => {
      const call = this.pending.get(message.id)
      if (!call) return
      this.pending.delete(message.id)
      this.activeId = null
      if (message.ok) call.resolve(message.result ?? [])
      else call.reject(new Error(message.error ?? '本地模型推理失败'))
      this.pump()
    })
    worker.on('error', (error) => this.rejectAll(error))
    worker.on('exit', (code) => {
      this.worker = null
      if (code !== 0) this.rejectAll(new Error(`本地模型 worker 异常退出（${code}）`))
    })
    this.worker = worker
    return worker
  }

  private rejectAll(error: Error): void {
    for (const call of this.pending.values()) call.reject(error)
    this.pending.clear()
    this.queue.length = 0
    this.activeId = null
  }

  embed(modelsRoot: string, manifest: LocalEmbeddingModelManifest, texts: string[], inputKind: 'query' | 'passage'): Promise<number[][]> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.queue.push({ id, priority: inputKind === 'query' ? 0 : 1, payload: { id, type: 'embed', modelsRoot, manifest, texts, inputKind } })
      this.queue.sort((a, b) => a.priority - b.priority || a.id - b.id)
      this.pump()
    })
  }

  async unload(): Promise<void> {
    if (!this.worker) return
    await this.callUnload().catch(() => {})
    await this.worker.terminate()
    this.worker = null
  }

  private callUnload(): Promise<number[][]> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.queue.push({ id, priority: 0, payload: { id, type: 'unload' } })
      this.pump()
    })
  }

  private pump(): void {
    if (this.activeId !== null || this.queue.length === 0) return
    const next = this.queue.shift()!
    this.activeId = next.id
    this.getWorker().postMessage(next.payload)
  }
}
