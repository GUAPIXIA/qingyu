/* eslint-disable @typescript-eslint/no-unused-vars */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const TEST_ROOT = '/tmp/qingyu-ctx-service-test'

vi.mock('electron', () => ({
  app: { getPath: () => TEST_ROOT, getVersion: () => '0.12.0' },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
}))

import { contextService } from '../contextService'

// 直接 mock 主进程数据提供者，避免磁盘依赖
vi.mock('../../context/mainContextProvider', () => ({
  mainContextProvider: {
    fetchBuildData: vi.fn(async (characterId: string) => {
      if (characterId === 'no-such') return { character: null, settings: { profile: null, settings: { activeModel: 'gpt-4o-mini' } }, chat: { messages: [], sessions: [], currentSessionId: null, activeLorebookIds: [], semanticFactsHits: [], semanticLoreHits: [] }, lorebooks: [], regexRules: [] }
      return {
        character: { id: 'char-1', name: 'Alice', description: 'desc', personality: 'kind', scenario: '', firstMessage: 'hi', exampleDialog: '', translatedContent: null, systemPrompt: '', postHistoryInstructions: '', authorNote: null } as unknown as Record<string, unknown>,
        preset: null,
        chat: { messages: [{ role: 'user', content: 'hi', id: 'm1', sessionId: 'sess-1', characterId: 'char-1', timestamp: Date.now() }], sessions: [{ id: 'sess-1', characterId: 'char-1', title: 'test', createdAt: Date.now(), updatedAt: Date.now() }], currentSessionId: 'sess-1', activeLorebookIds: [], semanticFactsHits: [], semanticLoreHits: [] },
        settings: { profile: { provider: 'openai', model: 'gpt-4o-mini', apiKey: 'sk-test', baseUrl: 'https://api.openai.com/v1' }, settings: { userName: '用户', activeModel: 'gpt-4o-mini', enableThoughtFormat: false, lorebookRatio: 0.3 } as unknown as Record<string, unknown> },
        lorebooks: [],
        regexRules: [],
      }
    }),
  },
}))

describe('ContextService', () => {
  it('含角色时组装消息并产出 fingerprint 与 model', async () => {
    const ctx = await contextService.build({ sessionId: 'sess-1', characterId: 'char-1', content: 'hello' })
    expect(ctx.messages.length).toBeGreaterThan(0)
    expect(ctx.fingerprint).toMatch(/^[a-f0-9]{16}$/)
    expect(ctx.model.provider).toBe('openai')
  })

  it('角色不存在抛错', async () => {
    await expect(contextService.build({ sessionId: 'sess-x', characterId: 'no-such', content: 'hi' })).rejects.toThrow(/角色不存在/)
  })
})
