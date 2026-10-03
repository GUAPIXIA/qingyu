/**
 * 画板 slice：剧情建议（结构阶段 4C 自 spatialStore.ts 拆出）。
 *
 * 剧情信封经模拟适配器按自动策略评估：可直接应用、生成待确认建议或拒绝；
 * 接受建议时放宽 from 守卫并按当前 revision 提交（用户显式确认语义）。
 */
import { runBatch } from '@qingyu/spatial-core'
import {
  createSimulatedStoryAdapter,
  describeEnvelope,
  parseStoryEnvelope,
} from '../story-adapter/index.ts'
import type {
  PendingSuggestion,
  StoryCommandEnvelope,
  StoryDecision,
} from '../story-adapter/index.ts'
import { now } from './spatialStoreHelpers.ts'
import type {
  SpatialStore,
  SpatialStoreGet,
  SpatialStoreSet,
} from './spatialStoreTypes.ts'

export type SpatialStoryActions = Pick<SpatialStore,
  | 'setAutoMovePolicy' | 'submitStoryEnvelope' | 'acceptSuggestion'
  | 'rejectSuggestion' | 'clearSuggestions'>

export function createSpatialStorySlice(set: SpatialStoreSet, get: SpatialStoreGet): SpatialStoryActions {
  return {
    setAutoMovePolicy: (policy) => {
      set({
        autoMovePolicy: policy,
        statusMessage:
          policy === 'off'
            ? '自动移动已关闭'
            : policy === 'suggest'
              ? '自动移动：建议模式（默认）'
              : '自动移动：自动应用高置信命令',
      })
    },

    submitStoryEnvelope: (input) => {
      const parsed = parseStoryEnvelope(input)
      if ('error' in parsed) {
        const decision: StoryDecision = {
          ok: false,
          code: 'schema_invalid',
          message: parsed.error,
        }
        set({ statusMessage: `剧情命令无效：${parsed.error}` })
        return decision
      }

      const envelope: StoryCommandEnvelope = parsed
      const { core, history, idGen, autoMovePolicy, pendingSuggestions } = get()

      const adapter = createSimulatedStoryAdapter({
        getCore: () => get().core,
        makeBatch: (env) => ({
          schemaVersion: 1,
          expectedRevision: env.expectedRevision,
          commands: env.commands,
        }),
      })

      const { decision } = adapter.evaluate(envelope, {
        policy: autoMovePolicy,
        now: now(),
        idGen,
        currentRevision: core.runtime.revision,
        worldId: core.world.id,
        runtimeId: core.runtime.runtimeId,
        minConfidence: 0.9,
      })

      if (decision.code === 'applied' && decision.ok) {
        const result = runBatch(
          core,
          history,
          {
            schemaVersion: 1,
            expectedRevision: envelope.expectedRevision,
            commands: envelope.commands,
          },
          {
            now: now(),
            source: 'story',
            idGen,
            label: 'story-batch',
            messageId: envelope.messageId,
          }
        )
        if (!result.batch.ok) {
          const failed: StoryDecision = {
            ok: false,
            code: 'batch_failed',
            message: `剧情命令应用失败：${result.batch.code}`,
          }
          const suggestion: PendingSuggestion = {
            id: idGen(),
            envelope,
            status: 'failed',
            label: describeEnvelope(envelope, core),
            reason: result.batch.code,
            createdAt: now(),
          }
          set({
            pendingSuggestions: [...pendingSuggestions, suggestion],
            statusMessage: failed.message,
          })
          return failed
        }
        set({
          core: result.batch.state,
          history: result.history,
          saveStatus: 'saving',
          statusMessage: decision.message,
        })
        return decision
      }

      if (decision.suggestion) {
        set({
          pendingSuggestions: [...pendingSuggestions, decision.suggestion],
          statusMessage: decision.message,
        })
        return decision
      }

      set({ statusMessage: decision.message })
      return decision
    },

    acceptSuggestion: (suggestionId) => {
      const { core, history, idGen, pendingSuggestions } = get()
      const sug = pendingSuggestions.find((s) => s.id === suggestionId)
      if (!sug || sug.status !== 'pending') return false

      // 用户显式确认：放宽 from 守卫，并以当前 revision 提交
      const commands = sug.envelope.commands.map((c) => {
        if (c.type === 'move_actor') {
          const { from: _from, ...rest } = c
          return rest
        }
        return c
      })
      const envelope = {
        ...sug.envelope,
        expectedRevision: core.runtime.revision,
        completed: true,
        commands,
      }
      const result = runBatch(
        core,
        history,
        {
          schemaVersion: 1,
          expectedRevision: envelope.expectedRevision,
          commands: envelope.commands,
        },
        {
          now: now(),
          source: 'story',
          idGen,
          label: 'story-accept',
          messageId: envelope.messageId,
        }
      )
      if (!result.batch.ok) {
        const code = result.batch.code
        set({
          pendingSuggestions: pendingSuggestions.map((s) =>
            s.id === suggestionId
              ? { ...s, status: 'failed' as const, reason: code }
              : s
          ),
          statusMessage: `接受建议失败：${code}`,
        })
        return false
      }
      set({
        core: result.batch.state,
        history: result.history,
        pendingSuggestions: pendingSuggestions.map((s) =>
          s.id === suggestionId ? { ...s, status: 'accepted' as const } : s
        ),
        saveStatus: 'saving',
        statusMessage: `已应用：${sug.label}`,
      })
      return true
    },

    rejectSuggestion: (suggestionId) => {
      set({
        pendingSuggestions: get().pendingSuggestions.map((s) =>
          s.id === suggestionId ? { ...s, status: 'rejected' } : s
        ),
        statusMessage: '已忽略该建议',
      })
    },

    clearSuggestions: () => {
      set({
        pendingSuggestions: get().pendingSuggestions.filter(
          (s) => s.status === 'pending'
        ),
      })
    },
  }
}