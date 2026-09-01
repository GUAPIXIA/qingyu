import type { LocalModelCatalogItem } from '../../shared/localModels'
import { compareModelVersions } from '../../shared/localModels'

export interface PendingModelUpdate {
  modelId: string
  version: string
  /** 该新版本用于替换当前默认模型（决定 auto 策略是否自动切换）。 */
  replacesActive: boolean
}

export interface LocalModelUpdatePlan {
  /** 需要下载的目录新版本（download 与 auto 策略都会执行）。 */
  install: PendingModelUpdate[]
  /** 已下载就绪、等待切换的默认模型继任版本（仅 auto 策略执行）。 */
  activate: PendingModelUpdate[]
}

/**
 * 按 updatePolicy 计算需要的自动更新动作。动作幂等：
 * 重复 install 返回进行中的任务引用，重复 activate 只是重新自检并写入 active。
 */
export function planModelUpdates(
  catalog: LocalModelCatalogItem[],
  policy: 'notify' | 'download' | 'auto',
): LocalModelUpdatePlan {
  const plan: LocalModelUpdatePlan = { install: [], activate: [] }
  if (policy === 'notify') return plan
  const byId = new Map<string, LocalModelCatalogItem[]>()
  for (const item of catalog) {
    const list = byId.get(item.manifest.id) ?? []
    list.push(item)
    byId.set(item.manifest.id, list)
  }
  for (const [modelId, items] of byId) {
    const installed = items.filter((item) => item.installedVersion === item.manifest.version)
    // 从未安装过的模型不参与自动更新，避免替用户下载从未选择的新模型
    if (installed.length === 0) continue
    const activeVersion = items.find((item) => item.active)?.manifest.version
    const newestInstalled = [...installed].sort((a, b) => compareModelVersions(b.manifest.version, a.manifest.version))[0]
    const newest = [...items].sort((a, b) => compareModelVersions(b.manifest.version, a.manifest.version))[0]
    if (!newest) continue
    const hasNewer = !newestInstalled || compareModelVersions(newest.manifest.version, newestInstalled.manifest.version) > 0
    const replacesActive = !!activeVersion && compareModelVersions(newest.manifest.version, activeVersion) > 0
    if (hasNewer) {
      plan.install.push({ modelId, version: newest.manifest.version, replacesActive })
    } else if (policy === 'auto' && replacesActive && newestInstalled && newestInstalled.manifest.version !== activeVersion) {
      plan.activate.push({ modelId, version: newestInstalled.manifest.version, replacesActive })
    }
  }
  return plan
}

/** 空闲时执行回调；用于"仅空闲时后台索引"。requestIdleCallback 不可用时退化为短延时。 */
export function whenIdle(fn: () => void, timeoutMs = 10_000): void {
  if (typeof window === 'undefined') { fn(); return }
  const requestIdle = (window as unknown as { requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number }).requestIdleCallback
  if (typeof requestIdle === 'function') requestIdle(fn, { timeout: timeoutMs })
  else window.setTimeout(fn, 1_000)
}
