/**
 * E-01 Preview 模式 — 当 window.api 不可用时（纯 Vite 预览、视觉回归），
 * 提供最小 mock，避免白屏；并展示预览横幅。
 */

export function isPreviewMode(): boolean {
  if (typeof window === 'undefined') return false
  // 显式 ?preview=1 或 window.api 缺失
  const params = new URLSearchParams(window.location.search)
  if (params.get('preview') === '1') return true
  return typeof (window as unknown as { api?: unknown }).api === 'undefined'
}

export function installPreviewMock(): void {
  if (typeof window === 'undefined') return
  const w = window as unknown as { api?: unknown; __previewMode?: boolean }
  if (w.api) return
  w.__previewMode = true
  // 最小 mock，满足各 store 的 load 调用不崩溃
  const noop = async () => undefined
  const list = async () => []
  w.api = {
    app: { getVersion: async () => '0.12.1-preview', checkVersion: async () => null, openExternal: noop },
    settings: { get: async () => { const { getDefaultSettings } = await import('../utils/defaults'); return getDefaultSettings() }, save: noop, saveAPICredential: noop, getAPICredential: async () => null, exportBackup: async () => ({ status: 'canceled' }), importBackup: async () => ({ status: 'canceled' }) },
    character: { list, get: async () => null, save: noop, delete: noop, importPng: async () => ({ success: false, canceled: true }), importJson: async () => ({ success: false, canceled: true }), importBatch: async () => ({ success: false, canceled: true }), bindLorebook: noop, exportPng: noop, exportJson: noop, exportCover: async () => ({ ok: false, canceled: true }), reloadAvatar: async () => ({ success: false, avatar: '' }), onImportProgress: () => () => {} },
    chat: { listSessions: list, createSession: async () => ({ id: 'preview', characterId: 'preview', title: '预览会话', createdAt: Date.now(), updatedAt: Date.now() }), deleteSession: noop, renameSession: noop, updateSession: async () => ({} as never), updateSessionIfMemoryVersion: async () => ({ applied: true, currentVersion: 0 }), listMessages: list, saveMessage: noop, deleteMessage: noop, clearChat: noop, exportChat: async () => '', updateMemory: noop, toggleMemory: noop, setMemoryMode: noop, getStats: async () => null, getMemoryHistory: async () => ({ history: [], total: 0 }) },
    lorebook: { list, save: noop, delete: noop, importJson: async () => null },
    embedding: { test: async () => ({ ok: false, error: '预览模式' }), indexLorebook: async () => ({ ok: false }), indexStatus: async () => ({}), removeIndex: async () => ({ ok: true }), semanticSearch: list, embedFacts: async () => [], searchFacts: async () => [] },
    localModel: { catalog: list, installed: list, tasks: list, install: async () => ({ taskId: 'preview' }), importPackage: async () => null, pause: noop, resume: noop, cancel: noop, test: async () => ({ ok: false, error: '预览模式' }), activate: async () => ({ ok: false }), rollback: async () => ({ ok: false }), uninstallImpact: async () => ({ active: false, modelBytes: 0, indexBytes: 0, lorebookCount: 0, entryCount: 0 }), uninstall: async () => ({ taskId: 'preview' }), storageUsage: async () => ({ modelBytes: 0, indexBytes: 0, stagingBytes: 0, totalBytes: 0 }), cleanup: async () => ({ ok: true, freedBytes: 0 }), rebuildIndexes: async () => ({ taskId: 'preview' }), onProgress: () => () => {} },
    quickReply: { listAll: async () => ({ global: [], byCharacter: {} }), saveAll: noop, clearCharacter: noop, exportJson: async () => ({ ok: false, canceled: true }), importJson: async () => ({ ok: false, canceled: true }) },
    preset: { list, save: async (p: unknown) => p as never, delete: noop, importJson: async () => null, exportJson: async () => ({ ok: false }) },
    tts: { speak: async () => ({ success: false }), stop: noop, pause: noop, resume: noop, getState: async () => ({ state: 'idle' as const }), onState: () => () => {}, listVoices: list },
    imageGen: {
      generate: async () => ({ success: false }),
      testConnection: async () => ({ success: false }),
      listLocalComfyWorkflows: async () => ({ success: true, workflows: [] }),
      importLocalComfyWorkflow: async () => ({ success: false, canceled: true }),
    },
    file: { selectImage: async () => null, readImageAsBase64: async () => '' },
    font: { selectFont: async () => null, saveFont: async () => ({ id: 'preview', name: 'preview', fileName: '', format: 'ttf', size: 0, createdAt: 0 } as never), listFonts: list, deleteFont: noop, getFontPath: async () => null },
    regex: { list, save: async (r: unknown) => r as never, delete: noop, create: async (n: string) => ({ id: 'preview', name: n, pattern: '', replacement: '', flags: 'g', enabled: true, scope: 'both' as const, group: '', stage: 'text' as const }) },
    persona: { list, save: async (p: unknown) => p as never, delete: noop, createDefault: async (n: string) => ({ id: 'preview', name: n, description: '', persona: '', avatar: '', createdAt: Date.now(), updatedAt: Date.now() } as never) },
    log: { write: noop, getRecent: async () => '' },
    usage: { record: async () => ({} as never), query: list, aggregate: list, summary: async () => ({ totalInput: 0, totalOutput: 0, totalChars: 0, count: 0 }), clear: noop },
    mcp: { listServers: list, listServerStatuses: list, addServer: async (c: unknown) => ({ id: 'preview', ...(c as object) } as never), updateServer: noop, removeServer: noop, startServer: noop, stopServer: noop, listTools: list, callTool: async () => ({ content: [] } as never) },
    group: { list, save: noop, delete: noop, listSessions: list, createSession: async () => ({ id: 'preview', groupId: 'preview', title: '预览', messageCount: 0, createdAt: Date.now(), updatedAt: Date.now() } as never), deleteSession: noop, renameSession: noop, listMessages: list, saveMessage: noop, saveMessagesBatch: noop, editMessage: noop, deleteMessage: noop, clearChat: noop, exportChat: async () => '', updateMemory: noop, toggleMemory: noop, setMemoryMode: noop, updateSession: noop, updateSessionIfMemoryVersion: async () => ({ applied: true, currentVersion: 0 }) },
    announcement: { fetchList: async () => ({ items: [], total: 0 }), fetchDetail: async () => null, getServerUrl: async () => '', setServerUrl: noop },
    updater: { check: async () => ({ status: 'none', message: '预览模式' }), download: async () => ({ status: 'none', message: '预览模式' }), install: noop, getState: async () => ({ status: 'idle', message: '预览模式' }), onEvent: () => () => {} },
    sessionSync: { changed: noop, onUpdated: () => () => {} },
    bridge: { status: async () => ({ running: false, config: { enabled: false, host: '127.0.0.1', port: 0, bindIps: [] }, bound: null } as never), start: async () => ({ ok: false }), stop: async () => ({ ok: false }), setConfig: async () => ({ ok: false }), pairingInfo: async () => ({ host: '', port: 0, fingerprint: '', expiresInSec: 0 }), regeneratePairing: async () => ({ host: '', port: 0, fingerprint: '', expiresInSec: 0 }), listDevices: list, revokeDevice: async () => ({ ok: false }), approvePair: async () => ({ ok: false }), rejectPair: async () => ({ ok: false }), onPairRequest: () => () => {}, wipeAll: async () => ({ ok: false }) },
    ai: { chat: noop, cancelChat: noop, testConnection: async () => ({ success: false }), listModels: async () => ({ success: false }), countTokens: async () => 0, countMessagesTokens: async () => [], compressLorebook: async () => '', localizeLorebookKeywords: async () => ({ suggestions: [] }), onChunk: () => () => {}, onDone: () => () => {}, onError: () => () => {}, onUsage: () => () => {} },
    chatTask: { start: async () => ({ taskId: 'preview', state: 'completed', lastSequence: 0 }), get: async () => null, listBySession: list, eventsAfter: async () => ({ events: [], hasMore: false } as never), cancel: async () => null as never, retry: async () => ({ taskId: 'preview', state: 'completed' }), onEvent: () => () => {} },
  } as never
}
