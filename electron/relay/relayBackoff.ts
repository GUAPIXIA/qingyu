const DELAYS = [0, 1, 2, 4, 8, 15, 30] as const
export class RelayBackoff {
  private attempt = 0
  reset(): void { this.attempt = 0 }
  next(random = Math.random): { attempt: number; delayMs: number } {
    const attempt = this.attempt++
    const seconds = DELAYS[Math.min(attempt, DELAYS.length - 1)]!
    return { attempt, delayMs: Math.round(seconds * 1000 * (0.8 + random() * 0.4)) }
  }
}
