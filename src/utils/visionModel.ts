/**
 * 识图模型解析（渲染层适配层，B1 反向依赖下沉）。
 *
 * 解析逻辑已下沉到 shared/chat-core/visionModel.ts（纯函数，主进程/Bridge 复用同一份），
 * 本文件只负责从 settings store 取出识图模型与主对话 Profile 后委托解析。
 */
import { useSettingsStore } from '../store/useSettingsStore'
import {
  contextHasImages,
  resolveVisionModel as resolveFromData,
  type ResolvedVisionModel,
  type VisionCandidate,
} from '../../shared/chat-core/visionModel'

export type { ResolvedVisionModel, VisionCandidate }
export { contextHasImages }

/**
 * 解析本轮请求应使用的识图模型连接。
 * 上下文含图片且激活了识图模型时返回完整连接（缺省字段回退当前 Profile），
 * 否则返回 null（使用主对话模型）。
 */
export function resolveVisionModel(messages: VisionCandidate[]): ResolvedVisionModel | null {
  const store = useSettingsStore.getState()
  return resolveFromData(messages, store.getActiveVision(), store.getActiveProfile())
}
