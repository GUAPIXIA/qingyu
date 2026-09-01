import type { LorebookCompatibilityReport } from '../../../shared/lorebook/adapters/types'

export class LorebookAdapterError extends Error {
  constructor(
    message: string,
    public readonly report?: LorebookCompatibilityReport,
  ) {
    super(message)
    this.name = 'LorebookAdapterError'
  }
}
