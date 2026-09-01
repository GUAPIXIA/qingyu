import { BridgeChatService, type SessionChangedNotifier } from '../chatService'
import { CompositeMobileEventSink, type MobileEventSink } from './mobileEventBus'
import { GenerationRegistry } from './generationRegistry'
import { DefaultMobileFacade } from './mobileFacade'

export class BridgeRuntime {
  readonly events = new CompositeMobileEventSink()
  readonly generations = new GenerationRegistry()
  readonly chatService: BridgeChatService
  readonly facade: DefaultMobileFacade

  constructor(notifySessionChanged: SessionChangedNotifier, initialSink?: MobileEventSink) {
    if (initialSink) this.events.add(initialSink)
    this.chatService = new BridgeChatService(this.events, notifySessionChanged, this.generations)
    this.facade = new DefaultMobileFacade(this.chatService, this.generations)
  }

  dispose(): void { this.generations.cancelAll() }
}
