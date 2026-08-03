import { useState } from 'react'
import { useSettingsStore } from '../../store/useSettingsStore'
import { PROVIDER_INFO } from '../../utils/defaults'
import { cn } from '../../lib/utils'
import type { VisionModelConfig, ProviderType } from '../../../shared/types'
import {
  Eye, EyeOff, Plus, Trash2, Check, X, Circle, ChevronUp, ChevronDown, Loader2, Plug,
} from 'lucide-react'

function emptyForm(): VisionModelConfig {
  return { id: '', name: '', provider: '', model: '', baseUrl: '', apiKey: '', enabled: true, order: 0 }
}

/** 协议类型：与对话 API 页一致（其余 OpenAI 兼容服务由 Base URL 区分） */
const PROVIDERS: ProviderType[] = ['openai', 'claude', 'gemini', 'ollama']

const providerLabel = (p: string | undefined): string =>
  (p && PROVIDER_INFO[p as ProviderType]?.name) || '跟随对话连接'

export function VisionModelsSection() {
  const {
    settings, addVisionModel, updateVisionModel, deleteVisionModel,
    setActiveVisionModelId, reorderVisionModels,
  } = useSettingsStore()

  const [editingId, setEditingId] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; models?: string[]; error?: string } | null>(null)
  const [form, setForm] = useState<VisionModelConfig>(emptyForm())

  const models = [...settings.visionModels].sort((a, b) => a.order - b.order)

  const resetForm = () => {
    setForm(emptyForm())
    setTestResult(null)
    setShowKey(false)
  }

  const openEdit = (m: VisionModelConfig) => {
    setForm({ ...m })
    setEditingId(m.id)
    setShowAdd(false)
    setTestResult(null)
    setShowKey(false)
  }

  const openAdd = () => {
    resetForm()
    setEditingId(null)
    setShowAdd(true)
  }

  const handleSave = () => {
    if (!form.name.trim()) return
    const payload = { ...form }
    if (editingId) {
      updateVisionModel(editingId, payload)
      setEditingId(null)
    } else {
      addVisionModel(payload)
      setShowAdd(false)
    }
    resetForm()
  }

  const handleDelete = (id: string) => {
    deleteVisionModel(id)
    if (editingId === id) {
      setEditingId(null)
      resetForm()
    }
  }

  const moveModel = (id: string, direction: 'up' | 'down') => {
    const idx = models.findIndex((m) => m.id === id)
    if (idx < 0) return
    const targetIdx = direction === 'up' ? idx - 1 : idx + 1
    if (targetIdx < 0 || targetIdx >= models.length) return
    const newModels = [...models]
    const [item] = newModels.splice(idx, 1)
    newModels.splice(targetIdx, 0, item)
    reorderVisionModels(newModels.map((m) => m.id))
  }

  /** 测试连接：跟随对话连接时复用当前 Profile 的 provider/baseUrl/apiKey */
  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const profile = useSettingsStore.getState().getActiveProfile()
      const type = ((form.provider?.trim() as ProviderType) || profile?.provider || 'openai') as ProviderType
      const res = await window.api.ai.testConnection({
        type,
        apiKey: form.apiKey?.trim() || profile?.apiKey || '',
        baseUrl: form.baseUrl?.trim() || profile?.baseUrl || '',
        model: form.model.trim() || 'gpt-4o-mini',
      })
      setTestResult(res)
    } catch (err) {
      setTestResult({ success: false, error: err instanceof Error ? err.message : '未知错误' })
    } finally {
      setTesting(false)
    }
  }

  /** 当前编辑的提供商是否在按钮组内（兼容旧配置中的其他 provider 值） */
  const providerInGroup = !form.provider || PROVIDERS.includes(form.provider as ProviderType)

  const renderForm = () => (
    <div className="space-y-3 mt-3">
      <div className="flex items-center gap-2">
        <input
          type="text"
          className="input text-sm flex-1"
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          placeholder="配置名称（如：GPT-4o 识图）"
          autoFocus
        />
        {editingId && (
          <button
            onClick={() => handleDelete(editingId)}
            className="p-2 rounded-lg text-tavern-text-muted hover:text-tavern-danger hover:bg-tavern-danger/10 transition-colors shrink-0"
            title="删除"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        )}
      </div>

      <div>
        <label className="label">连接方式 / 协议类型</label>
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => setForm((f) => ({ ...f, provider: '', apiKey: '', baseUrl: '' }))}
            className={cn(
              'px-2.5 py-1 rounded text-xs border transition-colors',
              !form.provider
                ? 'border-tavern-accent bg-tavern-accent-soft text-tavern-accent'
                : 'border-tavern-border-soft bg-tavern-bg-soft text-tavern-text-soft hover:border-tavern-border'
            )}
            title="复用当前对话 API 连接的提供商 / Base URL / API Key"
          >
            跟随对话连接
          </button>
          {PROVIDERS.map((pr) => (
            <button
              key={pr}
              onClick={() => setForm((f) => ({ ...f, provider: pr }))}
              className={cn(
                'px-2.5 py-1 rounded text-xs border transition-colors',
                form.provider === pr
                  ? 'border-tavern-accent bg-tavern-accent-soft text-tavern-accent'
                  : 'border-tavern-border-soft bg-tavern-bg-soft text-tavern-text-soft hover:border-tavern-border'
              )}
            >
              {PROVIDER_INFO[pr].name}
            </button>
          ))}
          {!providerInGroup && (
            <button
              onClick={() => setForm((f) => ({ ...f, provider: '' }))}
              className="px-2.5 py-1 rounded text-xs border border-tavern-warning/40 bg-tavern-warning/10 text-tavern-warning"
              title="旧配置中的提供商，点击改为跟随对话连接"
            >
              {providerLabel(form.provider)} ✕
            </button>
          )}
        </div>
        {!form.provider && (
          <p className="text-xs text-tavern-text-muted mt-1">
            复用当前对话 Profile 的提供商、Base URL 与 API Key，仅指定模型名称
          </p>
        )}
      </div>

      {form.provider && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="label">Base URL</label>
            <input
              type="text"
              className="input text-xs font-mono"
              value={form.baseUrl ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
              placeholder="留空 = 复用当前对话连接的 Base URL"
              spellCheck={false}
            />
          </div>
          <div>
            <label className="label">{PROVIDER_INFO[form.provider as ProviderType]?.keyLabel ?? 'API Key'}（留空复用）</label>
            <div className="relative">
              <input
                type={showKey ? 'text' : 'password'}
                className="input text-xs pr-10"
                value={form.apiKey ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
                placeholder={PROVIDER_INFO[form.provider as ProviderType]?.placeholder ?? 'sk-...'}
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-tavern-text-muted hover:text-tavern-text"
              >
                {showKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              </button>
            </div>
          </div>
        </div>
      )}

      <div>
        <label className="label">模型名称</label>
        <input
          type="text"
          className="input text-sm"
          value={form.model}
          onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
          placeholder="例如 gpt-4o、gemini-1.5-pro"
        />
        <p className="text-xs text-tavern-text-muted mt-1">
          发送含图片的消息时自动切换该模型识别。请填写支持视觉输入的模型（如 gpt-4o、qwen-vl 系列、gemini-1.5-pro）
        </p>
      </div>

      <div className="flex items-center gap-2">
        <button onClick={handleTest} disabled={testing} className="btn-secondary text-xs">
          {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plug className="w-3.5 h-3.5" />}
          测试连接
        </button>
        <button
          onClick={handleSave}
          disabled={!form.name.trim()}
          title={!form.name.trim() ? '请先填写配置名称' : '保存配置'}
          className="btn-primary text-xs"
        >
          <Check className="w-3.5 h-3.5" />
          保存
        </button>
        <button
          onClick={() => { if (editingId) setEditingId(null); else setShowAdd(false); resetForm() }}
          className="px-3 py-1.5 text-xs text-tavern-text-muted hover:text-tavern-text"
        >
          取消
        </button>

        {testResult && (
          <span
            className={cn(
              'inline-flex items-center gap-1 text-xs font-medium px-2 py-1 rounded',
              testResult.success
                ? 'text-tavern-success bg-tavern-success/10'
                : 'text-tavern-danger bg-tavern-danger/10'
            )}
          >
            {testResult.success ? (
              <><Check className="w-3 h-3" />成功</>
            ) : (
              <><X className="w-3 h-3" />{testResult.error ?? '失败'}</>
            )}
          </span>
        )}
      </div>

      {testResult && !testResult.success && testResult.error && (
        <p className="text-xs text-tavern-danger break-all bg-tavern-danger/5 rounded px-2 py-1.5">{testResult.error}</p>
      )}

      {testResult?.success && testResult.models && testResult.models.length > 0 && (
        <div>
          <p className="text-xs text-tavern-text-muted mb-1.5">可用模型（{testResult.models.length}）：</p>
          <div className="flex flex-wrap gap-1">
            {testResult.models.map((m) => (
              <button
                key={m}
                onClick={() => setForm((f) => ({ ...f, model: m }))}
                className={cn(
                  'px-2 py-0.5 rounded text-xs font-mono border transition-colors',
                  form.model === m
                    ? 'border-tavern-accent bg-tavern-accent-soft text-tavern-accent'
                    : 'border-tavern-border-soft bg-tavern-bg-soft hover:border-tavern-border text-tavern-text-soft'
                )}
              >
                {m}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )

  return (
    <div className="space-y-2">
      {models.length === 0 && !showAdd ? (
        <div className="text-center py-8">
          <Eye className="w-10 h-10 text-tavern-text-muted mx-auto mb-2 opacity-30" />
          <p className="text-sm text-tavern-text-muted mb-3">尚未配置识图模型</p>
          <button onClick={openAdd} className="btn-primary inline-flex items-center gap-1.5 text-xs">
            <Plus className="w-3.5 h-3.5" />添加识图模型
          </button>
        </div>
      ) : (
        <>
          {models.map((m, idx) => (
            <div
              key={m.id}
              className={cn(
                'rounded-xl border transition-colors',
                m.id === settings.activeVisionModelId
                  ? 'border-tavern-accent bg-tavern-accent-soft/30'
                  : 'border-tavern-border-soft bg-tavern-bg-card'
              )}
            >
              <div
                className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-tavern-bg-hover/50 rounded-t-xl"
                onClick={() => {
                  if (showAdd) return
                  if (editingId === m.id) {
                    resetForm()
                    setEditingId(null)
                  } else {
                    openEdit(m)
                  }
                }}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={(e) => { e.stopPropagation(); moveModel(m.id, 'up') }}
                      disabled={idx === 0}
                      className="p-0.5 text-tavern-text-muted hover:text-tavern-text disabled:opacity-30"
                    >
                      <ChevronUp className="w-3 h-3" />
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); moveModel(m.id, 'down') }}
                      disabled={idx === models.length - 1}
                      className="p-0.5 text-tavern-text-muted hover:text-tavern-text disabled:opacity-30"
                    >
                      <ChevronDown className="w-3 h-3" />
                    </button>
                  </div>
                  {/* 点击圆点切换启用 */}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      if (m.id !== settings.activeVisionModelId) setActiveVisionModelId(m.id)
                    }}
                    title={m.id === settings.activeVisionModelId ? '当前使用中' : '点击启用'}
                    className="p-0.5 -m-0.5 rounded-full hover:bg-tavern-bg-hover transition-colors shrink-0 group/dot"
                  >
                    <Circle
                      className={cn(
                        'w-3 h-3 transition-colors',
                        m.id === settings.activeVisionModelId
                          ? 'text-tavern-success fill-current'
                          : 'text-tavern-text-muted group-hover/dot:text-tavern-success'
                      )}
                    />
                  </button>
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-tavern-text truncate">{m.name}</div>
                    <div className="text-xs text-tavern-text-muted">
                      {providerLabel(m.provider)}{m.model ? ` · ${m.model}` : ''}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {m.id === settings.activeVisionModelId ? (
                    <span className="text-xs px-2 py-0.5 rounded bg-tavern-accent-soft text-tavern-accent font-medium">
                      使用中
                    </span>
                  ) : (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        setActiveVisionModelId(m.id)
                      }}
                      className="text-xs px-2 py-0.5 rounded border border-tavern-border-soft text-tavern-text-muted hover:text-tavern-accent hover:border-tavern-accent transition-colors"
                    >
                      启用
                    </button>
                  )}
                </div>
              </div>

              {editingId === m.id && (
                <div className="px-4 pb-4 pt-1 border-t border-tavern-border-soft">
                  {renderForm()}
                </div>
              )}
            </div>
          ))}

          {showAdd && (
            <div className="rounded-xl border border-tavern-accent bg-tavern-accent-soft/20">
              <div className="px-4 py-3 border-b border-tavern-border-soft flex items-center gap-2 text-sm font-medium text-tavern-accent">
                <Plus className="w-4 h-4" />新建识图配置
              </div>
              <div className="px-4 pb-4 pt-1">{renderForm()}</div>
            </div>
          )}

          {!showAdd && (
            <button
              onClick={openAdd}
              className="w-full flex items-center justify-center gap-1.5 py-2.5 rounded-xl border-2 border-dashed border-tavern-border-soft text-tavern-text-muted hover:border-tavern-accent hover:text-tavern-accent transition-colors"
            >
              <Plus className="w-4 h-4" />
              <span className="text-sm">添加识图模型</span>
            </button>
          )}
        </>
      )}
    </div>
  )
}
