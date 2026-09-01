import type { MobileEventSink } from '../bridge/runtime/mobileEventBus'
import type { MobileFacade } from '../bridge/runtime/mobileFacade'

interface CacheRecord { kind: 'character' | 'session' | 'message' | 'settings'; id: string; sessionId?: string; revision: number; payload: Record<string, unknown>; updatedAt: number }

export class RelayCachePublisher implements MobileEventSink {
  private revision = Date.now()
  private timer: NodeJS.Timeout | null = null
  constructor(private readonly facade: MobileFacade, private readonly send: (type: string, payload: unknown) => void) {}

  publish(event: string): void {
    if (event !== 'session:updated') return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = null; void this.publishSnapshot('cache:delta') }, 300)
  }

  async publishSnapshot(type: 'cache:snapshot' | 'cache:delta' = 'cache:snapshot'): Promise<void> {
    const now = Date.now(); const resources: CacheRecord[] = []
    const [characters, sessions, settings] = await Promise.all([
      this.facade.listCharacters(), this.facade.listSessions(), this.facade.settingsSnapshot(),
    ])
    for (const character of characters) resources.push(this.record('character', String(character.id), character, now))
    for (const session of sessions) {
      const sessionId = String(session.id); resources.push(this.record('session', sessionId, session, now))
      const page = await this.facade.listMessages({ sessionId, limit: 200 })
      for (const message of page.messages) {
        const images = Array.isArray(message.images) ? message.images : []
        const safeMessage = images.length ? { ...message, images: [], mediaUnavailable: true } : message
        resources.push({ ...this.record('message', String(message.id), safeMessage, now), sessionId })
      }
    }
    resources.push(this.record('settings', 'snapshot', settings as unknown as Record<string, unknown>, now))
    let batch: CacheRecord[] = []
    let batchType = type
    for (const resource of resources) {
      const candidate = [...batch, resource]
      if (batch.length && Buffer.byteLength(JSON.stringify({ resources: candidate })) > 220 * 1024) {
        this.send(batchType, { resources: batch })
        batch = [resource]
        batchType = 'cache:delta'
      } else batch = candidate
    }
    if (batch.length) this.send(batchType, { resources: batch })
  }

  dispose(): void { if (this.timer) clearTimeout(this.timer); this.timer = null }
  private record(kind: CacheRecord['kind'], id: string, payload: Record<string, unknown>, updatedAt: number): CacheRecord {
    return { kind, id, payload, updatedAt, revision: ++this.revision }
  }
}
