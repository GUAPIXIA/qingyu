/**
 * 识图模型解析
 *
 * 当上下文包含图片且用户配置了激活的识图模型时，本轮请求使用识图模型；
 * 否则回退主对话模型。
 *
 * 识图模型支持两种配置方式（字段级回退）：
 * - 只填模型名：连接参数（provider / baseUrl / apiKey）复用当前对话 Profile
 * - 完整独立配置：provider / baseUrl / apiKey 均可单独填写，留空的字段仍回退 Profile
 */
import { useSettingsStore } from '../store/useSettingsStore'
import type { ProviderType } from '../../shared/types'

/** 参与判断的消息（只需 images 字段） */
export interface VisionCandidate {
  images?: string[]
  [key: string]: unknown
}

/** 上下文中是否存在带图片的消息 */
export function contextHasImages(messages: VisionCandidate[]): boolean {
  return messages.some((m) => m.images && m.images.length > 0)
}

/** 解析后的识图模型连接（字段均已回退到有效值） */
export interface ResolvedVisionModel {
  provider: ProviderType
  model: string
  baseUrl: string
  apiKey: string
}

/**
 * 解析本轮请求应使用的识图模型连接。
 * 上下文含图片且激活了识图模型时返回完整连接（缺省字段回退当前 Profile），
 * 否则返回 null（使用主对话模型）。
 */
export function resolveVisionModel(messages: VisionCandidate[]): ResolvedVisionModel | null {
  if (!contextHasImages(messages)) return null
  const vision = useSettingsStore.getState().getActiveVision()
  if (!vision || !vision.model.trim()) return null

  const profile = useSettingsStore.getState().getActiveProfile()
  const fallbackProvider = (profile?.provider ?? 'openai') as ProviderType

  return {
    provider: (vision.provider?.trim() as ProviderType) || fallbackProvider,
    model: vision.model.trim(),
    baseUrl: vision.baseUrl?.trim() || profile?.baseUrl || '',
    apiKey: vision.apiKey?.trim() || profile?.apiKey || '',
  }
}
