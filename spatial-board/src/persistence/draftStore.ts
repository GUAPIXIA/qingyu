/**
 * 独立 IndexedDB 草稿仓储（不接触 Electron 正式数据）。
 */
import type { SpatialCoreState } from '@qingyu/spatial-core'

const DB_NAME = 'qingyu-spatial-board'
const DB_VERSION = 1
const STORE = 'drafts'
const DRAFT_KEY = 'current'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'))
  })
}

export interface DraftPayload {
  core: SpatialCoreState
  currentBoardId: string
  savedAt: number
}

export async function saveDraft(payload: DraftPayload): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(payload, DRAFT_KEY)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('save draft failed'))
  })
  db.close()
}

export async function loadDraft(): Promise<DraftPayload | null> {
  const db = await openDb()
  const result = await new Promise<DraftPayload | null>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(DRAFT_KEY)
    req.onsuccess = () => resolve((req.result as DraftPayload) ?? null)
    req.onerror = () => reject(req.error ?? new Error('load draft failed'))
  })
  db.close()
  return result
}

export async function clearDraft(): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(DRAFT_KEY)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('clear draft failed'))
  })
  db.close()
}
