import { useEffect } from 'react'
import { AlertCircle, CheckCircle2, Link2, Loader2, Plug } from 'lucide-react'
import type { Settings } from '../../../shared/types'
import { cn } from '../../lib/utils'
import { useSettingsStore } from '../../store/useSettingsStore'

interface SemanticSectionProps {
  settings: Settings
  updateSettings: (partial: Partial<Settings>) => void
  embedTestBusy: boolean
  embedTestResult: { ok: boolean; text: string } | null
  handleEmbedTest: () => void
}

/** 语义来源与召回参数面板；总策略和外层卡片由统一设置组件管理。 */
export function SemanticSection(props: SemanticSectionProps) {
  const { settings, updateSettings, embedTestBusy, embedTestResult, handleEmbedTest } = props
  const profiles = useSettingsStore((state) => state.settings.connectionProfiles)
  const trigger = settings.semanticTrigger

  useEffect(() => {
    if (!trigger?.enabled || trigger.provider === 'local' || profiles.length === 0) return
    if (trigger.profileId && profiles.some((profile) => profile.id === trigger.profileId)) return
    const profile = profiles[0]
    updateSettings({
      semanticTrigger: {
        ...trigger,
        profileId: profile.id,
        provider: profile.provider === 'ollama' ? 'ollama' : 'openai',
        baseUrl: profile.baseUrl,
        apiKey: profile.apiKey ?? '',
      },
    })
  // 只在档案集合或当前绑定变化时校正失效引用。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trigger?.enabled, trigger?.provider, trigger?.profileId, profiles.length])

  if (!trigger?.enabled) return null

  const isLocal = trigger.provider === 'local'
  const automaticThreshold = trigger.thresholdMode !== 'manual'

  return (
    <div className="space-y-4">
      {isLocal ? (
        <div className="rounded-lg border border-tavern-accent/30 bg-tavern-accent-soft px-3 py-2.5 text-xs">
          <p className="font-medium text-tavern-text">当前向量来源：{trigger.model || '本地默认模型'}</p>
          <p className="mt-1 text-tavern-text-muted">查询和世界书条目均在本机生成向量，不会发送给聊天 API；模型或索引不可用时自动回退到 BM25。</p>
        </div>
      ) : profiles.length === 0 ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-700 dark:text-amber-300">
          尚未创建连接档案。请先到 <span className="font-medium">对话 API</span> 页签创建连接，再选择远程 embeddings。
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3 py-1">
            <div className="flex items-center gap-2">
              <Link2 className="h-3.5 w-3.5 text-tavern-text-muted" />
              <div>
                <p className="text-sm">嵌入连接</p>
                <p className="text-xs text-tavern-text-muted">复用已有连接档案的地址与密钥</p>
              </div>
            </div>
            <select
              aria-label="嵌入连接"
              className="input w-52 px-2 py-1 text-sm"
              value={trigger.profileId ?? profiles[0]?.id ?? ''}
              onChange={(event) => {
                const profile = profiles.find((candidate) => candidate.id === event.target.value)
                if (!profile) return
                updateSettings({
                  semanticTrigger: {
                    ...trigger,
                    profileId: profile.id,
                    provider: profile.provider === 'ollama' ? 'ollama' : 'openai',
                    baseUrl: profile.baseUrl,
                    apiKey: profile.apiKey ?? '',
                  },
                })
              }}
            >
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name} · {profile.baseUrl || '无地址'} ({profile.provider})
                </option>
              ))}
            </select>
          </div>

          {(() => {
            const profile = profiles.find((candidate) => candidate.id === trigger.profileId) ?? profiles[0]
            if (!profile) return null
            return (
              <div className="space-y-1 rounded-lg bg-tavern-bg-hover px-3 py-2 text-xs">
                <div className="flex justify-between"><span className="text-tavern-text-muted">提供方</span><span className="font-medium">{profile.provider === 'ollama' ? 'Ollama' : 'OpenAI 兼容'}</span></div>
                <div className="flex justify-between gap-3"><span className="shrink-0 text-tavern-text-muted">Base URL</span><span className="truncate font-mono">{profile.baseUrl || '（未填写）'}</span></div>
                <div className="text-tavern-text-muted">密钥随档案复用，不在此处重复填写。</div>
              </div>
            )
          })()}

          <div>
            <label className="label" htmlFor="semantic-embedding-model">嵌入模型</label>
            <input
              id="semantic-embedding-model"
              type="text"
              className="input text-sm"
              placeholder={trigger.provider === 'ollama' ? 'nomic-embed-text' : 'text-embedding-3-small'}
              value={trigger.model}
              onChange={(event) => updateSettings({ semanticTrigger: { ...trigger, model: event.target.value.trim() } })}
            />
            <p className="mt-1 text-xs text-tavern-text-muted">这里填写嵌入模型，不是聊天模型；聊天 API 本身不需要支持语义索引。</p>
          </div>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <div className="flex items-center justify-between gap-3">
            <label className="label" htmlFor="semantic-threshold">
              相似度阈值：{automaticThreshold ? '自动校准' : `${((trigger.threshold ?? 0.3) * 100).toFixed(0)}%`}
            </label>
            <label className="flex items-center gap-1.5 text-xs text-tavern-text-muted">
              <input
                type="checkbox"
                checked={automaticThreshold}
                onChange={(event) => updateSettings({ semanticTrigger: { ...trigger, thresholdMode: event.target.checked ? 'auto' : 'manual' } })}
              />
              跟随模型
            </label>
          </div>
          <input
            id="semantic-threshold"
            type="range"
            min="0"
            max="100"
            step="5"
            disabled={automaticThreshold}
            value={Math.round((trigger.threshold ?? 0.3) * 100)}
            onChange={(event) => updateSettings({ semanticTrigger: { ...trigger, thresholdMode: 'manual', threshold: Number(event.target.value) / 100 } })}
            className="mt-1 w-full accent-tavern-accent disabled:opacity-40"
          />
          <div className="mt-1.5 flex gap-2">
            {[20, 30, 40, 50].map((value) => (
              <button
                key={value}
                className={cn(
                  'rounded border px-2.5 py-0.5 text-xs transition-colors',
                  Math.round((trigger.threshold ?? 0.3) * 100) === value
                    ? 'border-tavern-accent bg-tavern-accent-soft text-tavern-accent'
                    : 'border-tavern-border-soft text-tavern-text-muted hover:border-tavern-border',
                )}
                disabled={automaticThreshold}
                onClick={() => updateSettings({ semanticTrigger: { ...trigger, thresholdMode: 'manual', threshold: value / 100 } })}
              >
                {value}%
              </button>
            ))}
          </div>
          <p className="mt-1 text-xs text-tavern-text-muted">自动模式使用当前模型的召回评测值；切换为手动后，越高越严格。</p>
        </div>

        <div>
          <label className="label" htmlFor="semantic-max-results">每次最多注入条目数：{trigger.maxResults ?? 3}</label>
          <input
            id="semantic-max-results"
            type="range"
            min="1"
            max="10"
            step="1"
            value={trigger.maxResults ?? 3}
            onChange={(event) => updateSettings({ semanticTrigger: { ...trigger, maxResults: Number(event.target.value) } })}
            className="mt-1 w-full accent-tavern-accent"
          />
          <p className="mt-1 text-xs text-tavern-text-muted">限制单轮语义召回占用的上下文空间。</p>
        </div>
      </div>

      <div className="flex items-center gap-3 pt-1">
        <button className="btn-secondary text-xs" disabled={embedTestBusy} onClick={handleEmbedTest}>
          {embedTestBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plug className="h-3.5 w-3.5" />}
          测试向量来源
        </button>
        {embedTestResult && (
          <span className={cn('flex items-center gap-1 text-xs', embedTestResult.ok ? 'text-tavern-accent' : 'text-tavern-danger')}>
            {embedTestResult.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertCircle className="h-3.5 w-3.5" />}
            {embedTestResult.text}
          </span>
        )}
      </div>
    </div>
  )
}
