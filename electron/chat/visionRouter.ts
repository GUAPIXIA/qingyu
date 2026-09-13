/* eslint-disable @typescript-eslint/no-unused-vars */
/**
 * V12-07 VisionRouter：统一视觉模型选择（实施方案 §5.1 ModelPort 的 vision 分支）
 *
 * 含图消息 -> 激活 VisionModel，否则用当前 Profile。
 * 解析逻辑已下沉到 shared/chat-core/visionModel（B1）：识图模型与回退 Profile
 * 由调用方传入，主进程不再依赖渲染层 settings store。
 */
import {
  resolveVisionModel,
  type VisionModelSource,
  type VisionProfileFallback,
} from '../../shared/chat-core/visionModel'
import type { ContextPort } from './ports'

type VisionDecision = { provider: string; model: string; via: 'vision' | 'profile' }

export function routeVision(
  contextMessages: Array<{ role: string; content: string; images?: string[] }>,
  fallback: { provider: string; model: string },
  vision?: VisionModelSource | null,
  profile?: VisionProfileFallback | null,
): VisionDecision {
  const hit = resolveVisionModel(contextMessages, vision, profile)
  if (hit?.model) {
    return { provider: hit.provider ?? fallback.provider, model: hit.model, via: 'vision' }
  }
  return { provider: fallback.provider, model: fallback.model, via: 'profile' }
}
