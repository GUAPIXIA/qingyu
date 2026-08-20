/**
 * V12-07 VisionRouter：统一视觉模型选择（实施方案 §5.1 ModelPort 的 vision 分支）
 *
 * 含图消息 -> 激活 VisionModel，否则用当前 Profile。
 * 与 src/utils/visionModel.resolveVisionModel 语义一致，封装为 Port 供 Orchestrator 使用。
 */
import { resolveVisionModel } from '../../src/utils/visionModel'
import type { ContextPort } from './ports'

type VisionDecision = { provider: string; model: string; via: 'vision' | 'profile' }

export function routeVision(
  contextMessages: Array<{ role: string; content: string; images?: string[] }>,
  fallback: { provider: string; model: string },
): VisionDecision {
  const hit = resolveVisionModel(contextMessages as Parameters<typeof resolveVisionModel>[0])
  if (hit?.model) {
    return { provider: hit.provider ?? fallback.provider, model: hit.model, via: 'vision' }
  }
  return { provider: fallback.provider, model: fallback.model, via: 'profile' }
}
