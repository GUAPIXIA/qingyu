import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity,
  BrainCircuit,
  Gauge,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  WalletCards,
  Wrench,
} from 'lucide-react'
import type { GenerationDiagnostics } from '../../../shared/ipc-api'
import type { ConnectionProfile, ResponseLengthMode, Settings } from '../../../shared/types'
import type { ReasoningGateLevel } from '../../../shared/reasoningGate'
import { RESPONSE_LENGTH_LABELS } from '../../../shared/responsePolicy'
import { cn } from '../../lib/utils'
import { SectionCard, Toggle } from '../../components/common/SettingsShared'

interface Props {
  settings: Settings
  updateSettings: (partial: Partial<Settings>) => void
}

const EFFORT_OPTIONS: Array<{ value: 'auto' | ReasoningGateLevel; label: string; detail: string }> = [
  { value: 'auto', label: '自动', detail: '跟随模型档案与运行状态' },
  { value: 'off', label: '关闭', detail: '优先保留正文空间' },
  { value: 'low', label: '较低', detail: '限制推理开销' },
  { value: 'standard', label: '标准', detail: '平衡推理与正文' },
  { value: 'full', label: '充分', detail: '允许模型完整推理' },
]

const SOURCE_LABELS: Record<string, string> = {
  exact: '内置精确档案',
  family: '模型家族推断',
  fallback: '保守回退',
  runtime: '用户或运行时修正',
}

const EMPTY_CAPABILITY: NonNullable<ConnectionProfile['capabilityOverride']> = { enabled: false }

function Metric({ label, value, suffix }: { label: string; value: string | number; suffix?: string }) {
  return (
    <div className="rounded-xl border border-tavern-border-soft bg-tavern-bg-card/55 px-3 py-2.5">
      <dt className="text-[10px] font-medium uppercase tracking-[0.14em] text-tavern-text-muted">{label}</dt>
      <dd className="mt-1 font-mono text-sm font-semibold tabular-nums text-tavern-text">
        {value}{suffix && <span className="ml-1 text-[10px] font-normal text-tavern-text-muted">{suffix}</span>}
      </dd>
    </div>
  )
}

export function GenerationPlanningSection({ settings, updateSettings }: Props) {
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [diagnostics, setDiagnostics] = useState<GenerationDiagnostics | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const activeProfile = useMemo(
    () => settings.connectionProfiles.find((profile) => profile.id === settings.activeProfileId) ?? null,
    [settings.activeProfileId, settings.connectionProfiles],
  )
  const model = settings.activeModel || activeProfile?.model || ''
  const capability = activeProfile?.capabilityOverride ?? EMPTY_CAPABILITY

  const updateCapability = (patch: Partial<NonNullable<ConnectionProfile['capabilityOverride']>>) => {
    if (!activeProfile) return
    updateSettings({
      connectionProfiles: settings.connectionProfiles.map((profile) => profile.id === activeProfile.id
        ? { ...profile, capabilityOverride: { enabled: false, ...profile.capabilityOverride, ...patch } }
        : profile),
    })
  }

  const refreshDiagnostics = useCallback(async () => {
    if (!activeProfile || !model || !window.api.ai.getGenerationDiagnostics) {
      setDiagnostics(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      setDiagnostics(await window.api.ai.getGenerationDiagnostics({
        provider: activeProfile.provider,
        baseUrl: activeProfile.baseUrl,
        model,
        capabilityOverride: capability,
      }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '诊断读取失败')
    } finally {
      setLoading(false)
    }
  }, [activeProfile, capability, model])

  useEffect(() => {
    if (advancedOpen) void refreshDiagnostics()
  }, [advancedOpen, refreshDiagnostics])

  const resetProbe = async () => {
    if (!activeProfile || !model) return
    setLoading(true)
    setError(null)
    try {
      await window.api.ai.resetGenerationGateProbe({
        provider: activeProfile.provider,
        baseUrl: activeProfile.baseUrl,
        model,
      })
      await refreshDiagnostics()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '重置失败')
      setLoading(false)
    }
  }

  const last = diagnostics?.lastRequest
  const mainUsage = diagnostics?.usageBuckets.find((bucket) => bucket.taskType === 'main')
  const actualBodyTokens = last
    && typeof last.completionTokens === 'number'
    && typeof last.reasoningTokens === 'number'
    ? Math.max(0, last.completionTokens - last.reasoningTokens)
    : '未知'

  return (
    <SectionCard title="生成规划" icon={<BrainCircuit className="h-4 w-4" />} storageKey="generation-planning">
      <div className="mt-3 overflow-hidden rounded-2xl border border-tavern-border-soft bg-tavern-bg-soft/25">
        <div className="border-b border-tavern-border-soft bg-[radial-gradient(circle_at_top_right,rgba(245,158,11,0.12),transparent_55%)] px-4 py-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="flex items-center gap-2 text-sm font-semibold text-tavern-text">
                <Sparkles className="h-4 w-4 text-tavern-accent" /> 每轮按内容动态安排
              </p>
              <p className="mt-1 max-w-2xl text-xs leading-relaxed text-tavern-text-muted">
                篇幅、推理空间与上下文共享同一份计划；连续性规则始终生效，切换模型不会改写记忆或世界书。
              </p>
            </div>
            <span className={cn(
              'shrink-0 rounded-full border px-2 py-1 text-[10px] font-semibold',
              settings.reasoningGateEnabled
                ? 'border-tavern-success/25 bg-tavern-success/10 text-tavern-success'
                : 'border-tavern-border-soft bg-tavern-bg-card text-tavern-text-muted',
            )}>
              推理保护{settings.reasoningGateEnabled ? '已开启' : '已暂停'}
            </span>
          </div>
        </div>

        <div className="grid gap-px bg-tavern-border-soft lg:grid-cols-2">
          <div className="bg-tavern-bg-card/70 p-4">
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-tavern-text-soft">
              <Gauge className="h-3.5 w-3.5 text-tavern-accent" /> 默认回复长度
            </div>
            <div className="grid grid-cols-4 gap-1 rounded-xl bg-tavern-bg-soft p-1" role="radiogroup" aria-label="默认回复长度">
              {(['auto', 'brief', 'balanced', 'detailed'] as ResponseLengthMode[]).map((value) => {
                const selected = (settings.defaultResponseLength ?? 'auto') === value
                return (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => updateSettings({ defaultResponseLength: value })}
                    className={cn(
                      'rounded-lg px-2 py-2 text-xs transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tavern-accent/45',
                      selected ? 'bg-tavern-bg-card text-tavern-accent shadow-sm' : 'text-tavern-text-muted hover:text-tavern-text',
                    )}
                  >
                    {RESPONSE_LENGTH_LABELS[value]}
                  </button>
                )
              })}
            </div>
            <p className="mt-2 text-[11px] text-tavern-text-muted">会话选择、预设或本轮明确要求仍具有更高优先级。</p>
          </div>

          <div className="bg-tavern-bg-card/70 p-4">
            <div className="mb-2 flex items-center justify-between gap-3">
              <span className="flex items-center gap-2 text-xs font-semibold text-tavern-text-soft">
                <BrainCircuit className="h-3.5 w-3.5 text-tavern-accent" /> 思考强度
              </span>
              <Toggle
                label="动态推理保护"
                checked={settings.reasoningGateEnabled === true}
                onChange={(reasoningGateEnabled) => updateSettings({ reasoningGateEnabled })}
              />
            </div>
            <select
              aria-label="思考强度"
              value={settings.reasoningEffort ?? 'auto'}
              disabled={settings.reasoningGateEnabled !== true}
              onChange={(event) => updateSettings({ reasoningEffort: event.target.value as Settings['reasoningEffort'] })}
              className="input w-full text-sm disabled:cursor-not-allowed disabled:opacity-50"
            >
              {EFFORT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label} · {option.detail}</option>)}
            </select>
            <p className="mt-2 text-[11px] text-tavern-text-muted">端点不支持所选档位时会保守降级，不会无限重试。</p>
          </div>

          <div className="bg-tavern-bg-card/70 p-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="flex items-center gap-2 text-xs font-semibold text-tavern-text-soft"><ShieldCheck className="h-3.5 w-3.5 text-tavern-success" /> 连续性保护</p>
                <p className="mt-1 text-[11px] leading-relaxed text-tavern-text-muted">避免与最近事实、已完成动作和已说过的信息矛盾或重复。</p>
              </div>
              <span className="rounded-full bg-tavern-success/10 px-2 py-1 text-[10px] font-semibold text-tavern-success">始终开启</span>
            </div>
          </div>

          <div className="space-y-3 bg-tavern-bg-card/70 p-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-xs font-semibold text-tavern-text-soft">自动补全结尾</p>
                <p className="mt-0.5 text-[11px] text-tavern-text-muted">仅在长度触顶且没有稳定结尾时尝试一次。</p>
              </div>
              <Toggle label="自动补全结尾" checked={settings.autoTailRepairEnabled !== false} onChange={(autoTailRepairEnabled) => updateSettings({ autoTailRepairEnabled })} />
            </div>
            <div className="flex items-center justify-between gap-4 border-t border-tavern-border-soft pt-3">
              <div>
                <p className="flex items-center gap-1.5 text-xs font-semibold text-tavern-text-soft"><WalletCards className="h-3.5 w-3.5" /> 费用提醒</p>
                <p className="mt-0.5 text-[11px] text-tavern-text-muted">在快捷设置提示高预算；硬上限安全校验始终有效。</p>
              </div>
              <Toggle label="费用提醒" checked={settings.costReminderEnabled !== false} onChange={(costReminderEnabled) => updateSettings({ costReminderEnabled })} />
            </div>
          </div>
        </div>
      </div>

      <button
        type="button"
        aria-expanded={advancedOpen}
        onClick={() => setAdvancedOpen((value) => !value)}
        className="mt-3 flex w-full items-center justify-between rounded-xl border border-tavern-border-soft bg-tavern-bg-soft/35 px-4 py-3 text-left transition-colors hover:bg-tavern-bg-hover/55"
      >
        <span className="flex items-center gap-2 text-sm font-medium text-tavern-text"><Wrench className="h-4 w-4 text-tavern-text-muted" /> 高级能力与诊断</span>
        <span className="text-xs text-tavern-text-muted">{advancedOpen ? '收起' : '展开'}</span>
      </button>

      {advancedOpen && (
        <div className="mt-3 space-y-3" data-testid="generation-advanced">
          {!activeProfile ? (
            <div className="rounded-xl border border-dashed border-tavern-border px-4 py-6 text-center text-sm text-tavern-text-muted">请先在“模型”中选择一个对话连接。</div>
          ) : (
            <>
              <div className="rounded-2xl border border-tavern-border-soft bg-tavern-bg-card/55 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-tavern-text">{activeProfile.name}</p>
                    <p className="mt-0.5 text-xs text-tavern-text-muted">{activeProfile.provider} · {model}</p>
                  </div>
                  <label className="flex items-center gap-2 text-xs text-tavern-text-soft">
                    启用自定义能力
                    <Toggle label="启用自定义能力" checked={capability.enabled === true} onChange={(enabled) => updateCapability({ enabled })} />
                  </label>
                </div>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <label className="text-xs text-tavern-text-muted">
                    自定义输入窗口
                    <input aria-label="自定义输入窗口" type="number" min="1" disabled={!capability.enabled} value={capability.contextLimit ?? ''} onChange={(event) => updateCapability({ contextLimit: Math.max(0, Number(event.target.value) || 0) || undefined })} placeholder="跟随模型档案" className="input mt-1.5 w-full font-mono text-sm disabled:opacity-50" />
                  </label>
                  <label className="text-xs text-tavern-text-muted">
                    自定义输出能力
                    <input aria-label="自定义输出能力" type="number" min="1" disabled={!capability.enabled} value={capability.outputLimit ?? ''} onChange={(event) => updateCapability({ outputLimit: Math.max(0, Number(event.target.value) || 0) || undefined })} placeholder="跟随模型档案" className="input mt-1.5 w-full font-mono text-sm disabled:opacity-50" />
                  </label>
                </div>
                <p className="mt-3 text-[11px] leading-relaxed text-tavern-text-muted">模型输出硬上限仍在预设高级项中设置：0 为自动，正数为每轮严格上限。通用 8192 安全阀保持不变。</p>
              </div>

              <div className="rounded-2xl border border-tavern-border-soft bg-tavern-bg-soft/25 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="flex items-center gap-2 text-sm font-semibold text-tavern-text"><Activity className="h-4 w-4 text-tavern-accent" /> 脱敏运行诊断</p>
                    <p className="mt-0.5 text-[11px] text-tavern-text-muted">不包含 API Key、完整端点、提示词或回复正文。</p>
                  </div>
                  <button type="button" aria-label="刷新生成诊断" onClick={() => void refreshDiagnostics()} disabled={loading} className="btn-secondary !px-2.5 !py-1.5 text-xs"><RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />刷新</button>
                </div>
                {error && <p role="alert" className="mt-3 text-xs text-tavern-danger">{error}</p>}
                {diagnostics && (
                  <>
                    <dl className="mt-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
                      <Metric label="输入能力" value={diagnostics.modelProfile.contextLimit.toLocaleString()} suffix="tok" />
                      <Metric label="输出能力" value={diagnostics.modelProfile.outputLimit.toLocaleString()} suffix="tok" />
                      <Metric label="能力来源" value={SOURCE_LABELS[diagnostics.modelProfile.source] ?? diagnostics.modelProfile.source} />
                      <Metric label="置信度" value={diagnostics.modelProfile.confidence === 'high' ? '高' : '低'} />
                    </dl>

                    <div className="mt-3 grid gap-3 lg:grid-cols-2">
                      <div className="rounded-xl border border-tavern-border-soft bg-tavern-bg-card/55 p-3">
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-xs font-semibold text-tavern-text-soft">端点门控探测</p>
                          <button type="button" onClick={() => void resetProbe()} disabled={loading || !diagnostics.gateProbe} className="text-[11px] text-tavern-accent disabled:opacity-40">重置探测</button>
                        </div>
                        {diagnostics.gateProbe ? (
                          <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-tavern-text-muted">
                            <dt>方式</dt><dd className="text-right font-mono text-tavern-text-soft">{diagnostics.gateProbe.knob}</dd>
                            <dt>参数接受</dt><dd className="text-right">{diagnostics.gateProbe.knobAccepted === false ? '拒绝' : '未拒绝'}</dd>
                            <dt>关闭被忽略</dt><dd className="text-right">{diagnostics.gateProbe.disableIgnored ? '是' : '否'}</dd>
                            <dt>推理用量上报</dt><dd className="text-right">{diagnostics.gateProbe.reportsReasoningUsage ? '是' : '未知'}</dd>
                          </dl>
                        ) : <p className="mt-2 text-[11px] text-tavern-text-muted">尚无此端点的门控探测记录。</p>}
                      </div>

                      <div className="rounded-xl border border-tavern-border-soft bg-tavern-bg-card/55 p-3">
                        <p className="text-xs font-semibold text-tavern-text-soft">近期用量档案</p>
                        {mainUsage ? (
                          <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-tavern-text-muted">
                            <dt>样本</dt><dd className="text-right font-mono">{mainUsage.profile.sampleCount}</dd>
                            <dt>Reasoning P90</dt><dd className="text-right font-mono">{mainUsage.profile.reasoningP90 ?? '未知'}</dd>
                            <dt>正文 P95</dt><dd className="text-right font-mono">{mainUsage.profile.bodyVisibleCharsP95 ?? '未知'}</dd>
                            <dt>推理挤占率</dt><dd className="text-right font-mono">{(mainUsage.profile.reasoningFilledRate * 100).toFixed(1)}%</dd>
                          </dl>
                        ) : <p className="mt-2 text-[11px] text-tavern-text-muted">尚无主对话聚合样本。</p>}
                      </div>
                    </div>

                    <div className="mt-3 rounded-xl border border-tavern-border-soft bg-tavern-bg-card/55 p-3">
                      <p className="text-xs font-semibold text-tavern-text-soft">最后一轮计划 / 实际</p>
                      {last ? (
                        <dl className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                          <Metric label="分类" value={last.generationType ?? last.taskType} />
                          <Metric label="请求上限" value={last.requestedMaxTokens} suffix="tok" />
                          <Metric label="计划正文" value={last.plannedBodyTokens ?? '未知'} suffix={last.plannedBodyTokens == null ? undefined : 'tok'} />
                          <Metric label="实际正文" value={actualBodyTokens} suffix={actualBodyTokens === '未知' ? undefined : 'tok'} />
                          <Metric label="正文字符" value={last.bodyVisibleChars} suffix="字" />
                          <Metric label="计划推理" value={last.plannedReasoningTokens ?? '未知'} suffix={last.plannedReasoningTokens == null ? undefined : 'tok'} />
                          <Metric label="实际推理" value={last.reasoningTokens} suffix={last.reasoningTokens === 'unknown' ? undefined : 'tok'} />
                          <Metric label="调用次数" value={last.attempts} />
                          <Metric label="结果" value={last.terminationCause ?? last.finishReason} />
                        </dl>
                      ) : <p className="mt-2 text-[11px] text-tavern-text-muted">尚无可显示的请求记录。</p>}
                    </div>
                    <p className="mt-3 text-[10px] text-tavern-text-muted">已扫描 {diagnostics.observationStore.scannedRecords} 条；跳过损坏行 {diagnostics.observationStore.skippedLines} 条。诊断文件路径不会暴露给界面。</p>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </SectionCard>
  )
}
