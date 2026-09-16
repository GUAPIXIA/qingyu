import { app } from 'electron'
import { ensureSyncDomain, journalPutIfEnabled, journalDeleteIfEnabled } from '../domain/syncDomainService'
import { createLogger } from '../services/logger'

const log = createLogger('bridge-journal')

/** Bridge 写路径 journal（flag 开启时）；失败不阻断伴侣业务 */
export function bridgeJournalPut(input: {
  domain: Parameters<typeof journalPutIfEnabled>[0]['domain']
  entityType: Parameters<typeof journalPutIfEnabled>[0]['entityType']
  entityId: string
  parentId?: string | null
  payload: Record<string, unknown>
}): void {
  try {
    ensureSyncDomain(app.getPath('userData'))
    journalPutIfEnabled(input)
  } catch (err) {
    log.warn('bridge journal 失败', { err: String(err), entityType: input.entityType })
  }
}

export function bridgeJournalDelete(input: {
  domain: Parameters<typeof journalDeleteIfEnabled>[0]['domain']
  entityType: Parameters<typeof journalDeleteIfEnabled>[0]['entityType']
  entityId: string
}): void {
  try {
    ensureSyncDomain(app.getPath('userData'))
    journalDeleteIfEnabled(input)
  } catch (err) {
    log.warn('bridge journal delete 失败', { err: String(err), entityType: input.entityType })
  }
}
