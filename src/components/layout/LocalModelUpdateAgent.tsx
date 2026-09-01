import { useEffect, useRef } from 'react'
import { useSettingsStore } from '../../store/useSettingsStore'
import { planModelUpdates, whenIdle } from '../../lib/localModelUpdates'

/**
 * updatePolicy 的执行端：应用启动时按策略安装目录新版本；'auto' 策略在新版本
 * 自检就绪后自动切换默认模型，并按 idleOnly 延迟重建索引。'notify' 时不做任何
 * 动作（模型中心徽章提醒）。切换只改写指向本地模型的 semanticTrigger，
 * 不会劫持用户的远程 embeddings 配置。
 */
export function LocalModelUpdateAgent() {
  const pendingAutoActivate = useRef(new Map<string, string>())
  const busy = useRef(false)

  useEffect(() => {
    const api = window.api?.localModel
    if (!api) return
    let disposed = false

    const activateNewVersion = async (modelId: string, version: string) => {
      busy.current = true
      try {
        const result = await api.activate(modelId, version)
        if (!result.ok) return
        const store = useSettingsStore.getState()
        const trigger = store.settings.semanticTrigger
        if (trigger?.provider === 'local') {
          store.updateSettings({ semanticTrigger: { ...trigger, enabled: true, model: `${modelId}@${version}` } })
        }
        const prefs = store.settings.localModels
        if (prefs?.autoIndex) whenIdle(() => { void window.api.localModel.rebuildIndexes() })
      } catch { /* 切换失败保持旧版本可用，用户可在模型中心手动处理 */ } finally {
        busy.current = false
      }
    }

    const applyPlan = async () => {
      if (busy.current) return
      const prefs = useSettingsStore.getState().settings.localModels
      if (!prefs || prefs.updatePolicy === 'notify') return
      try {
        const catalog = await api.catalog()
        const plan = planModelUpdates(catalog, prefs.updatePolicy)
        pendingAutoActivate.current.clear()
        for (const update of plan.activate) void activateNewVersion(update.modelId, update.version)
        for (const update of plan.install) {
          if (update.replacesActive) pendingAutoActivate.current.set(update.modelId, update.version)
          await api.install(update.modelId, update.version).catch(() => {})
        }
      } catch { /* 目录读取失败时保持现状，下次启动重试 */ }
    }

    void applyPlan()
    const unsubscribe = api.onProgress(({ task }) => {
      if (disposed || busy.current || task.kind !== 'install' || task.state !== 'ready') return
      if (pendingAutoActivate.current.get(task.modelId) !== task.version) return
      pendingAutoActivate.current.delete(task.modelId)
      const prefs = useSettingsStore.getState().settings.localModels
      if (prefs?.updatePolicy !== 'auto') return
      void activateNewVersion(task.modelId, task.version)
    })
    return () => { disposed = true; unsubscribe() }
  }, [])

  return null
}
