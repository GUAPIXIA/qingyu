import { UserRound, Brain, CheckCircle2, AlertCircle, Loader2, Plug } from 'lucide-react'
import { cn } from '../../lib/utils'
import { Toggle, SectionCard } from '../../components/common/SettingsShared'
import type { Settings } from '../../../shared/types'

interface SemanticSectionProps {
  settings: Settings
  updateSettings: (partial: Partial<Settings>) => void
  embedTestBusy: boolean
  embedTestResult: { ok: boolean; text: string } | null
  handleEmbedTest: () => void
}

/** 用户人设注入 + 语义触发(向量 RAG) */
export function SemanticSection(props: SemanticSectionProps) {
  const { settings, updateSettings, embedTestBusy, embedTestResult, handleEmbedTest } = props
  return (
    <>
        <SectionCard title="用户人设注入" icon={<UserRound className="w-4 h-4" />}>
          <div className="mt-3 space-y-4">
            <div className="flex items-center justify-between py-1">
              <div>
                <p className="text-sm">注入用户人设</p>
                <p className="text-xs text-tavern-text-muted">将用户名/描述/性格注入模型上下文（关闭后仅保留 {'{{user}}'} 变量替换）</p>
              </div>
              <Toggle
                checked={settings.personaInjection?.enabled ?? true}
                onChange={(v) => updateSettings({
                  personaInjection: {
                    ...(settings.personaInjection ?? { position: 'system', includeDescription: true, includePersona: true }),
                    enabled: v,
                  },
                })}
              />
            </div>

            {(settings.personaInjection?.enabled ?? true) && (
              <>
                <div className="flex items-center justify-between py-1">
                  <div>
                    <p className="text-sm">注入位置</p>
                    <p className="text-xs text-tavern-text-muted">system = 拼入系统提示词（默认）；separate = 独立系统消息</p>
                  </div>
                  <select
                    className="input text-sm py-1 px-2 w-36"
                    value={settings.personaInjection?.position ?? 'system'}
                    onChange={(e) => updateSettings({
                      personaInjection: {
                        ...(settings.personaInjection ?? { enabled: true, includeDescription: true, includePersona: true }),
                        position: e.target.value as 'system' | 'separate',
                      },
                    })}
                  >
                    <option value="system">系统提示内</option>
                    <option value="separate">独立系统消息</option>
                  </select>
                </div>

                <div className="space-y-2">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      className="accent-[var(--color-accent)]"
                      checked={settings.personaInjection?.includeDescription ?? true}
                      onChange={(e) => updateSettings({
                        personaInjection: {
                          ...(settings.personaInjection ?? { enabled: true, position: 'system', includePersona: true }),
                          includeDescription: e.target.checked,
                        },
                      })}
                    />
                    <span className="text-sm">注入用户描述</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      className="accent-[var(--color-accent)]"
                      checked={settings.personaInjection?.includePersona ?? true}
                      onChange={(e) => updateSettings({
                        personaInjection: {
                          ...(settings.personaInjection ?? { enabled: true, position: 'system', includeDescription: true }),
                          includePersona: e.target.checked,
                        },
                      })}
                    />
                    <span className="text-sm">注入用户性格</span>
                  </label>
                </div>
              </>
            )}
          </div>
        </SectionCard>

        {/* 语义触发（向量 RAG） */}
        <SectionCard title="语义触发" icon={<Brain className="w-4 h-4" />}>
          <div className="mt-3 space-y-4">
            <div className="flex items-center justify-between py-1">
              <div>
                <p className="text-sm">启用语义触发</p>
                <p className="text-xs text-tavern-text-muted">
                  世界书条目按语义相似度触发（如“猫娘”可触发含“猫咪”的条目）。需先为世界书生成向量索引
                </p>
              </div>
              <Toggle
                checked={settings.semanticTrigger?.enabled ?? false}
                onChange={(v) => updateSettings({
                  semanticTrigger: {
                    ...(settings.semanticTrigger ?? { provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'nomic-embed-text', apiKey: '', threshold: 0.3, maxResults: 3 }),
                    enabled: v,
                  },
                })}
              />
            </div>

            {settings.semanticTrigger?.enabled && (
              <>
                <div className="flex items-center justify-between py-1">
                  <div>
                    <p className="text-sm">嵌入服务</p>
                    <p className="text-xs text-tavern-text-muted">本地推荐 Ollama（免费），也可用 OpenAI 兼容 embeddings 服务</p>
                  </div>
                  <select
                    className="input text-sm py-1 px-2 w-32"
                    value={settings.semanticTrigger.provider}
                    onChange={(e) => updateSettings({
                      semanticTrigger: {
                        ...settings.semanticTrigger!,
                        provider: e.target.value as 'openai' | 'ollama',
                      },
                    })}
                  >
                    <option value="ollama">Ollama（本地）</option>
                    <option value="openai">OpenAI 兼容</option>
                  </select>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="label">Base URL</label>
                    <input
                      type="text"
                      className="input text-sm"
                      placeholder={settings.semanticTrigger.provider === 'ollama' ? 'http://localhost:11434' : 'https://api.openai.com/v1'}
                      value={settings.semanticTrigger.baseUrl}
                      onChange={(e) => updateSettings({
                        semanticTrigger: { ...settings.semanticTrigger!, baseUrl: e.target.value.trim() },
                      })}
                    />
                  </div>
                  <div>
                    <label className="label">模型</label>
                    <input
                      type="text"
                      className="input text-sm"
                      placeholder={settings.semanticTrigger.provider === 'ollama' ? 'nomic-embed-text' : 'text-embedding-3-small'}
                      value={settings.semanticTrigger.model}
                      onChange={(e) => updateSettings({
                        semanticTrigger: { ...settings.semanticTrigger!, model: e.target.value.trim() },
                      })}
                    />
                  </div>
                </div>

                {settings.semanticTrigger.provider === 'openai' && (
                  <div>
                    <label className="label">API Key</label>
                    <input
                      type="password"
                      className="input text-sm"
                      placeholder="sk-..."
                      value={settings.semanticTrigger.apiKey ?? ''}
                      onChange={(e) => updateSettings({
                        semanticTrigger: { ...settings.semanticTrigger!, apiKey: e.target.value.trim() },
                      })}
                    />
                  </div>
                )}

                <div>
                  <label className="label">
                    相似度阈值：{((settings.semanticTrigger.threshold ?? 0.3) * 100).toFixed(0)}%
                  </label>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    step="5"
                    value={Math.round((settings.semanticTrigger.threshold ?? 0.3) * 100)}
                    onChange={(e) => updateSettings({
                      semanticTrigger: {
                        ...settings.semanticTrigger!,
                        threshold: Number(e.target.value) / 100,
                      },
                    })}
                    className="w-full accent-tavern-accent mt-1"
                  />
                  <div className="flex gap-2 mt-1.5">
                    {[20, 30, 40, 50].map(v => (
                      <button
                        key={v}
                        className={cn(
                          'px-2.5 py-0.5 text-xs rounded border transition-colors',
                          Math.round(((settings.semanticTrigger?.threshold ?? 0.3)) * 100) === v
                            ? 'border-tavern-accent bg-tavern-accent-soft text-tavern-accent'
                            : 'border-tavern-border-soft text-tavern-text-muted hover:border-tavern-border'
                        )}
                        onClick={() => updateSettings({
                          semanticTrigger: { ...settings.semanticTrigger!, threshold: v / 100 },
                        })}
                      >
                        {v}%
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-tavern-text-muted mt-1">阈值越高越严格，误触发越少但可能漏触发</p>
                </div>

                <div>
                  <label className="label">每次最多注入条目数：{settings.semanticTrigger.maxResults ?? 3}</label>
                  <input
                    type="range"
                    min="1"
                    max="10"
                    step="1"
                    value={settings.semanticTrigger.maxResults ?? 3}
                    onChange={(e) => updateSettings({
                      semanticTrigger: { ...settings.semanticTrigger!, maxResults: Number(e.target.value) },
                    })}
                    className="w-full accent-tavern-accent mt-1"
                  />
                </div>

                <div className="flex items-center gap-3 pt-1">
                  <button
                    className="btn-secondary text-xs"
                    disabled={embedTestBusy}
                    onClick={handleEmbedTest}
                  >
                    {embedTestBusy ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Plug className="w-3.5 h-3.5" />
                    )}
                    测试连接
                  </button>
                  {embedTestResult && (
                    <span className={cn(
                      'text-xs flex items-center gap-1',
                      embedTestResult.ok ? 'text-tavern-accent' : 'text-tavern-danger'
                    )}>
                      {embedTestResult.ok
                        ? <CheckCircle2 className="w-3.5 h-3.5" />
                        : <AlertCircle className="w-3.5 h-3.5" />}
                      {embedTestResult.text}
                    </span>
                  )}
                </div>

                <p className="text-xs text-tavern-text-muted pt-1">
                  配置完成后，到「世界书」页面为世界书点击「生成语义索引」，并把条目匹配模式设为「语义」或「关键词 + 语义」。
                </p>
              </>
            )}
          </div>
        </SectionCard>
    </>
  )
}
