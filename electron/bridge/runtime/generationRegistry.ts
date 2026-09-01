/** Owns cancellable mobile generations independently from any transport. */
export class GenerationRegistry {
  private readonly controllers = new Map<string, AbortController>()

  create(requestId: string): AbortController {
    this.cancel(requestId)
    const controller = new AbortController()
    this.controllers.set(requestId, controller)
    return controller
  }

  register(requestId: string, controller: AbortController): void {
    this.cancel(requestId)
    this.controllers.set(requestId, controller)
  }

  cancel(requestId: string): boolean {
    const controller = this.controllers.get(requestId)
    if (!controller) return false
    controller.abort()
    this.controllers.delete(requestId)
    return true
  }

  release(requestId: string): void {
    this.controllers.delete(requestId)
  }

  cancelAll(): void {
    for (const controller of this.controllers.values()) controller.abort()
    this.controllers.clear()
  }
}
