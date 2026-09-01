export interface MobileEventSink {
  publish(event: string, payload?: unknown, targetDeviceId?: string): void
}

export class CompositeMobileEventSink implements MobileEventSink {
  constructor(private readonly sinks: MobileEventSink[] = []) {}

  add(sink: MobileEventSink): () => void {
    this.sinks.push(sink)
    return () => {
      const index = this.sinks.indexOf(sink)
      if (index >= 0) this.sinks.splice(index, 1)
    }
  }

  publish(event: string, payload?: unknown, targetDeviceId?: string): void {
    for (const sink of [...this.sinks]) sink.publish(event, payload, targetDeviceId)
  }
}
