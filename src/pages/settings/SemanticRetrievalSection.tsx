import { useState } from 'react'
import { Brain, Cloud, Cpu, Search, Sparkles } from 'lucide-react'
import type { LocalModelPreferences, SemanticTriggerConfig, Settings } from '../../../shared/types'
import { SectionCard, Toggle } from '../../components/common/SettingsShared'
import { cn } from '../../lib/utils'
import { LocalModelsSection } from './LocalModelsSection'
import { SemanticSection } from './SemanticSection'

interface Props {
  settings: Settings
  updateSettings: (partial: Partial<Settings>) => void
  embedTestBusy: boolean
  embedTestResult: { ok: boolean; text: string } | null
  handleEmbedTest: () => void
}

type RetrievalMode = LocalModelPreferences['retrievalMode']

const strategies: Array<{
  value: RetrievalMode
  label: string
  description: string
  icon: typeof Sparkles
}> = [
  { value: 'auto', label: '自动', description: '本地优先，按可用配置降级', icon: Sparkles },
  { value: 'local', label: '本地模型', description: '隐私优先，在本机 CPU 运行', icon: Cpu },
  { value: 'remote', label: '远程 embeddings', description: '复用 API 连接档案', icon: Cloud },
  { value: 'lexical', label: '仅词法', description: '关键词、正则与 BM25', icon: Search },
]

function defaultTrigger(current?: SemanticTriggerConfig): SemanticTriggerConfig {
  return current ?? {
    enabled: false,
    provider: 'ollama',
    baseUrl: 'http://localhost:11434',
    model: 'nomic-embed-text',
    apiKey: '',
    threshold: 0.3,
    maxResults: 3,
  }
}

/** 本地模型、远程向量来源与语义召回参数的唯一用户入口。 */
export function SemanticRetrievalSection(props: Props) {
  const { settings, updateSettings, embedTestBusy, embedTestResult, handleEmbedTest } = props
  const preferences = settings.localModels ?? {
    retrievalMode: 'auto' as const,
    autoIndex: true,
    updatePolicy: 'notify' as const,
    idleOnly: true,
    batchSize: 8,
  }
  const trigger = defaultTrigger(settings.semanticTrigger)
  const [strategyBusy, setStrategyBusy] = useState(false)
  const [strategyMessage, setStrategyMessage] = useState<{ ok: boolean; text: string } | null>(null)

  const setStrategy = async (mode: RetrievalMode) => {
    const alreadyAligned = mode === 'lexical'
      ? !trigger.enabled
      : mode === 'local'
        ? trigger.enabled && trigger.provider === 'local'
        : mode === 'remote'
          ? trigger.enabled && trigger.provider !== 'local'
          : trigger.enabled
    if (mode === preferences.retrievalMode && alreadyAligned) return
    setStrategyBusy(true)
    setStrategyMessage(null)
    try {
      if (mode === 'lexical') {
        updateSettings({
          localModels: { ...preferences, retrievalMode: mode },
          semanticTrigger: { ...trigger, enabled: false },
        })
        return
      }

      if (mode === 'local' || mode === 'auto') {
        const installed = await window.api.localModel.installed()
        const active = installed.find((item) => item.active)
        if (active) {
          updateSettings({
            localModels: { ...preferences, retrievalMode: mode },
            semanticTrigger: {
              ...trigger,
              enabled: true,
              provider: 'local',
              baseUrl: '',
              apiKey: '',
              profileId: null,
              model: `${active.manifest.id}@${active.manifest.version}`,
            },
          })
          return
        }
        if (mode === 'local') {
          setStrategyMessage({ ok: false, text: '请先在下方安装模型，并点击“测试并设为默认”。' })
          return
        }
      }

      const profile = settings.connectionProfiles[0]
      if (profile) {
        const provider = profile.provider === 'ollama' ? 'ollama' as const : 'openai' as const
        updateSettings({
          localModels: { ...preferences, retrievalMode: mode },
          semanticTrigger: {
            ...trigger,
            enabled: true,
            provider,
            profileId: profile.id,
            baseUrl: profile.baseUrl,
            apiKey: profile.apiKey ?? '',
            model: trigger.provider === provider && trigger.model
              ? trigger.model
              : provider === 'ollama' ? 'nomic-embed-text' : 'text-embedding-3-small',
          },
        })
        return
      }

      if (mode === 'remote') {
        setStrategyMessage({ ok: false, text: '没有可用的连接档案。请先在”对话 API”页签创建连接。' })
        return
      }

      // 自动模式没有可用向量来源：语义检索不可用，统一落到仅词法（等同关闭开关）
      updateSettings({
        localModels: { ...preferences, retrievalMode: 'lexical' },
        semanticTrigger: { ...trigger, enabled: false },
      })
      setStrategyMessage({ ok: true, text: '当前没有可用的向量来源，已使用关键词与 BM25；安装模型后可直接启用。' })
    } catch (error) {
      setStrategyMessage({ ok: false, text: error instanceof Error ? error.message : '无法切换检索策略' })
    } finally {
      setStrategyBusy(false)
    }
  }

  const status = preferences.retrievalMode === 'lexical' || !trigger.enabled
    ? { label: '词法检索', detail: preferences.retrievalMode === 'auto' ? '自动模式当前没有可用向量来源' : '不会调用嵌入模型' }
    : trigger.provider === 'local'
      ? { label: '本地向量', detail: trigger.model || '本地默认模型' }
      : { label: '远程向量', detail: trigger.model || '尚未填写嵌入模型' }

  /** 语义检索是否生效（开关开且策略非仅词法） */
  const semanticActive = trigger.enabled && preferences.retrievalMode !== 'lexical'

  /** 总开关：关闭时同步为仅词法（语义检索停用，关键词/正则/BM25 仍工作）；开启时恢复原策略偏好 */
  const setSemanticEnabled = (enabled: boolean) => {
    if (enabled) {
      updateSettings({
        localModels: { ...preferences, retrievalMode: 'auto' },
        semanticTrigger: { ...trigger, enabled: true },
      })
      return
    }
    updateSettings({
      localModels: { ...preferences, retrievalMode: 'lexical' },
      semanticTrigger: { ...trigger, enabled: false },
    })
  }

  return (
    <SectionCard title="语义检索" icon={<Brain className="h-4 w-4" />} storageKey="semantic-retrieval">
      <div className="mt-3 space-y-6">
        <div className="flex flex-col gap-3 rounded-lg border border-tavern-border-soft bg-tavern-bg-hover/45 p-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-tavern-text-muted">当前生效</p>
            <p className="mt-1 text-sm font-medium text-tavern-text">{status.label}</p>
            <p className="mt-0.5 text-xs text-tavern-text-muted">{status.detail}</p>
          </div>
          <div className="flex items-center gap-3">
            <Toggle
              checked={semanticActive}
              onChange={setSemanticEnabled}
              label="启用语义检索"
            />
            <div className="text-xs text-tavern-text-muted">
              <p className="font-medium text-tavern-text">语义检索 {semanticActive ? '已开启' : '已关闭'}</p>
              <p>{semanticActive ? '向量召回与词法兜底共同生效' : '仅使用关键词、正则与 BM25'}</p>
            </div>
          </div>
        </div>

        <div>
          <div className="mb-2">
            <h3 className="text-sm font-medium">检索策略</h3>
            <p className="mt-0.5 text-xs text-tavern-text-muted">选择向量来源偏好；"仅词法"会关闭语义检索（等同顶部开关关闭）。</p>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4" role="radiogroup" aria-label="检索策略">
            {strategies.map((strategy) => {
              const Icon = strategy.icon
              const selected = preferences.retrievalMode === strategy.value
              return (
                <button
                  key={strategy.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={strategyBusy}
                  onClick={() => void setStrategy(strategy.value)}
                  className={cn(
                    'flex min-h-20 items-start gap-2.5 rounded-lg border p-3 text-left transition-colors',
                    selected
                      ? 'border-tavern-accent bg-tavern-accent-soft text-tavern-accent'
                      : 'border-tavern-border-soft bg-tavern-bg hover:border-tavern-border hover:bg-tavern-bg-hover',
                  )}
                >
                  <Icon className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    <span className="block text-sm font-medium">{strategy.label}</span>
                    <span className={cn('mt-1 block text-xs leading-4', selected ? 'text-tavern-accent/80' : 'text-tavern-text-muted')}>{strategy.description}</span>
                  </span>
                </button>
              )
            })}
          </div>
          {strategyMessage && <p className={cn('mt-2 text-xs', strategyMessage.ok ? 'text-tavern-success' : 'text-tavern-danger')}>{strategyMessage.text}</p>}
        </div>

        {semanticActive && (
          <section className="space-y-3 border-t border-tavern-border-soft pt-4" aria-labelledby="semantic-source-heading">
            <div>
              <h3 id="semantic-source-heading" className="text-sm font-medium">向量来源与召回</h3>
              <p className="mt-0.5 text-xs text-tavern-text-muted">配置当前生效来源以及世界书语义条目的召回范围。</p>
            </div>
            <SemanticSection
              settings={settings}
              updateSettings={updateSettings}
              embedTestBusy={embedTestBusy}
              embedTestResult={embedTestResult}
              handleEmbedTest={handleEmbedTest}
            />
          </section>
        )}

        <section className="space-y-3 border-t border-tavern-border-soft pt-4" aria-labelledby="local-model-heading">
          <div>
            <h3 id="local-model-heading" className="text-sm font-medium">本地模型与索引</h3>
            <p className="mt-0.5 text-xs text-tavern-text-muted">可随时下载安装；只有设为默认后才参与本地向量检索。</p>
          </div>
          <LocalModelsSection embedded settings={settings} updateSettings={updateSettings} />
        </section>
      </div>
    </SectionCard>
  )
}
