import type { Character, Preset } from '../../shared/types'
import { buildContextMessagesFromData } from '../context/contextBuilder'
import { syncBuildData } from '../context/rendererContextProvider'
import { markPendingCompression } from './streamController'
import type { ContextMessage, StoreGet, StoreSet } from './chatTypes'

/**
 * 阶段 0b：组装逻辑已抽离至 src/context/contextBuilder.ts（纯模块，两端共用）。
 *
 * 本文件退化为薄封装：
 * 1. rendererContextProvider.syncBuildData 从现有 Zustand store 同步构造数据快照；
 * 2. contextBuilder.buildContextMessagesFromData 完成全部组装（system prompt /
 *    世界书 / 正则管线 / 记忆注入 / 预算裁剪 / 深度注入）；
 * 3. lastContextUsage 与 pendingCompression 写回 store（副作用集中在此）。
 *
 * 行为与迁移前完全一致（防漂移快照测试锁定，src/context/__tests__/contextBuilder.test.ts）。
 */
export function buildChatContext(
  get: StoreGet,
  set: StoreSet,
  character: Character,
  preset: Preset | null,
  opts?: { continuation?: boolean; trackUsage?: boolean },
): ContextMessage[] {
  const data = syncBuildData(character, preset)
  const result = buildContextMessagesFromData(data, opts)
  // 记录上下文用量（P1-3：上限预警）
  // M-27 修复：trackUsage=false（ContextViewer 等只读查看场景）不写 lastContextUsage——
  // 渲染期调用此前会用 preset=null 口径覆盖真实发送路径的用量记录，导致 85% 预警误报/漏报
  if (opts?.trackUsage !== false) {
    set({ lastContextUsage: result.lastContextUsage })
  }
  // 上下文溢出压缩任务：流式完成后异步执行（原 buildChatContext 内直接标记）
  if (result.pendingCompression) {
    markPendingCompression(result.pendingCompression)
  }
  return result.messages
}
