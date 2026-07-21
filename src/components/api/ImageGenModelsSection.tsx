import { useState } from 'react'
import { useSettingsStore } from '../../store/useSettingsStore'
import { cn } from '../../lib/utils'
import type { ImageGenModelConfig } from '../../../shared/types'
import {
  Image, Plus, Trash2, Check, Eye, EyeOff,
  Circle, ChevronUp, ChevronDown, Loader2,
} from 'lucide-react'

/** 提供商选项 */
const PROVIDERS = [
  { value: 'openai', label: 'OpenAI DALL-E' },
  { value: 'sd-webui', label: 'SD WebUI (A1111)' },
]

/** OpenAI DALL-E 尺寸选项 */
const OPENAI_SIZES = [
  '1024x1024', '1792x1024', '1024x1792',
  '512x512', '256x256',
]

/** SD WebUI 尺寸选项 */
const SD_SIZES = [
  '512x512', '768x768', '1024x1024',
  '512x768', '768x512',
]

/** SD WebUI 采样器选项 */
const SD_SAMPLERS = [
  'Euler a', 'Euler', 'LMS', 'Heun', 'DPM2', 'DPM2 a',
  'DPM++ 2S a', 'DPM++ 2M', 'DPM++ SDE', 'DPM fast',
  'DDIM', 'PLMS', 'UniPC',
]

const IMAGE_QUALITIES = [
  { value: 'standard', label: '标准' },
  { value: 'hd', label: 'HD 高清' },
]

/** 根据 provider 返回空表单默认值 */
function emptyForm(provider: string = 'openai'): ImageGenModelConfig {
  if (provider === 'sd-webui') {
    return {
      id: '', name: '', provider: 'sd-webui',
      model: '', apiKey: '', baseUrl: 'http://127.0.0.1:7860',
      size: '512x512', quality: 'standard',
      enabled: true, order: 0,
      negativePrompt: '',
      steps: 20,
      cfgScale: 7,
      sampler: 'Euler a',
    }
  }
  return {
    id: '', name: '', provider: 'openai',
    model: '', apiKey: '', baseUrl: 'https://api.openai.com/v1',
    size: '1024x1024', quality: 'standard',
    enabled: true, order: 0,
  }
}

export function ImageGenModelsSection() {
  const {
    settings, addImageGenModel, updateImageGenModel, deleteImageGenModel,
    setActiveImageGenModelId, reorderImageGenModels,
  } = useSettingsStore()

  const [editingId, setEditingId] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const [form, setForm] = useState<ImageGenModelConfig>(emptyForm())
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null)

  const models = [...settings.imageGenModels].sort((a, b) => a.order - b.order)

  const isSdWebui = form.provider === 'sd-webui'
  const sizeOptions = isSdWebui ? SD_SIZES : OPENAI_SIZES

  const resetForm = () => {
    setForm(emptyForm())
    setShowKey(false)
  }

  const openEdit = (m: ImageGenModelConfig) => {
    setForm({ ...m })
    setEditingId(m.id)
    setShowAdd(false)
    setShowKey(false)
    setTestResult(null)
  }

  const openAdd = () => {
    resetForm()
    setEditingId(null)
    setShowAdd(true)
    setTestResult(null)
  }

  /** 切换 provider 时重置相关默认值 */
  const handleProviderChange = (provider: string) => {
    setForm((f) => {
      const defaults = emptyForm(provider)
      return {
        ...f,
        provider,
        baseUrl: f.baseUrl || defaults.baseUrl,
        size: defaults.size,
      }
    })
    setTestResult(null)
  }

  /** 测试连接 */
  const handleTestConnection = async () => {
    if (!form.baseUrl.trim()) return
    setTesting(true)
    setTestResult(null)
    try {
      const result = await window.api.imageGen.testConnection({
        provider: form.provider,
        baseUrl: form.baseUrl,
        apiKey: form.apiKey,
      })
      setTestResult({
        success: result.success,
        message: result.success ? (result.message ?? '连接成功') : (result.error ?? '连接失败'),
      })
    } catch (e) {
      setTestResult({ success: false, message: e instanceof Error ? e.message : String(e) })
    } finally {
      setTesting(false)
    }
  }

  const handleSave = () => {
    if (!form.name.trim()) return
    if (editingId) {
      updateImageGenModel(editingId, form)
      setEditingId(null)
    } else {
      addImageGenModel(form)
      setShowAdd(false)
    }
    resetForm()
  }

  const handleDelete = (id: string) => {
    deleteImageGenModel(id)
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
    reorderImageGenModels(newModels.map((m) => m.id))
  }

  const renderForm = () => (
    <div className="space-y-3 mt-3">
      {/* 名称 */}
      <input
        type="text"
        className="input text-sm"
        value={form.name}
        onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
        placeholder="配置名称（如：本地 SD / DALL-E 3）"
        autoFocus
      />

      {/* 提供商（下拉选择） */}
      <div>
        <label className="label">提供商</label>
        <div className="flex flex-wrap gap-1.5">
          {PROVIDERS.map((p) => (
            <button
              key={p.value}
              onClick={() => handleProviderChange(p.value)}
              className={cn(
                'px-2.5 py-1 rounded text-xs border transition-colors',
                form.provider === p.value
                  ? 'border-tavern-accent bg-tavern-accent-soft text-tavern-accent'
                  : 'border-tavern-border-soft bg-tavern-bg-soft text-tavern-text-soft hover:border-tavern-border'
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Base URL */}
      <div>
        <label className="label">Base URL</label>
        <input
          type="text"
          className="input text-xs font-mono"
          value={form.baseUrl}
          onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
          placeholder={isSdWebui ? 'http://127.0.0.1:7860' : 'https://api.openai.com/v1'}
        />
      </div>

      {/* API Key（仅 OpenAI 显示） */}
      {!isSdWebui && (
        <div>
          <label className="label">API Key</label>
          <div className="relative">
            <input
              type={showKey ? 'text' : 'password'}
              className="input text-xs pr-10"
              value={form.apiKey}
              onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
              placeholder="sk-..."
              autoComplete="off"
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
      )}

      {/* 模型名称 */}
      <div>
        <label className="label">模型名称</label>
        <input
          type="text"
          className="input text-sm"
          value={form.model}
          onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
          placeholder={isSdWebui ? '（可选，如 v1-5-pruned）' : '例如 dall-e-3'}
        />
      </div>

      {/* 尺寸 */}
      <div>
        <label className="label">图片尺寸（默认值，可在快捷面板覆盖）</label>
        <select
          className="input text-sm"
          value={form.size}
          onChange={(e) => setForm((f) => ({ ...f, size: e.target.value }))}
        >
          {sizeOptions.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>

      {/* 质量（仅 OpenAI 显示） */}
      {!isSdWebui && (
        <div>
          <label className="label">生成质量</label>
          <div className="flex flex-wrap gap-1.5 mt-1">
            {IMAGE_QUALITIES.map((q) => (
              <button
                key={q.value}
                onClick={() => setForm((f) => ({ ...f, quality: q.value }))}
                className={cn(
                  'px-2.5 py-1 rounded text-xs border transition-colors',
                  form.quality === q.value
                    ? 'border-tavern-accent bg-tavern-accent-soft text-tavern-accent'
                    : 'border-tavern-border-soft bg-tavern-bg-soft text-tavern-text-soft hover:border-tavern-border'
                )}
              >
                {q.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* SD WebUI 特有参数 */}
      {isSdWebui && (
        <>
          {/* 负面提示词 */}
          <div>
            <label className="label">负面提示词</label>
            <textarea
              className="input text-xs resize-none"
              rows={2}
              value={form.negativePrompt ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, negativePrompt: e.target.value }))}
              placeholder="如: lowres, bad anatomy, bad hands, text, error"
            />
          </div>

          {/* 步数 + CFG */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">采样步数 (Steps)</label>
              <input
                type="number"
                className="input text-sm"
                value={form.steps ?? 20}
                min={1}
                max={150}
                onChange={(e) => setForm((f) => ({ ...f, steps: parseInt(e.target.value) || 20 }))}
              />
            </div>
            <div>
              <label className="label">CFG Scale</label>
              <input
                type="number"
                className="input text-sm"
                value={form.cfgScale ?? 7}
                min={1}
                max={30}
                step={0.5}
                onChange={(e) => setForm((f) => ({ ...f, cfgScale: parseFloat(e.target.value) || 7 }))}
              />
            </div>
          </div>

          {/* 采样器 */}
          <div>
            <label className="label">采样器</label>
            <select
              className="input text-sm"
              value={form.sampler ?? 'Euler a'}
              onChange={(e) => setForm((f) => ({ ...f, sampler: e.target.value }))}
            >
              {SD_SAMPLERS.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
        </>
      )}

      {/* 操作按钮 */}
      <div className="flex items-center gap-2 flex-wrap">
        <button onClick={handleSave} disabled={!form.name.trim()} className="btn-primary text-xs">
          <Check className="w-3.5 h-3.5" />保存
        </button>
        <button
          onClick={handleTestConnection}
          disabled={!form.baseUrl.trim() || testing}
          className="px-3 py-1.5 rounded-lg text-xs border border-tavern-border-soft text-tavern-text-soft hover:border-tavern-accent hover:text-tavern-accent transition-colors disabled:opacity-50 flex items-center gap-1.5"
        >
          {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Circle className="w-3 h-3" />}
          {testing ? '测试中...' : '测试连接'}
        </button>
        <button
          onClick={() => { editingId ? setEditingId(null) : setShowAdd(false); resetForm() }}
          className="px-3 py-1.5 text-xs text-tavern-text-muted hover:text-tavern-text"
        >
          取消
        </button>
      </div>

      {/* 测试结果 */}
      {testResult && (
        <div className={cn(
          'text-xs px-3 py-2 rounded-lg border',
          testResult.success
            ? 'border-tavern-success/30 bg-tavern-success/10 text-tavern-success'
            : 'border-tavern-danger/30 bg-tavern-danger/10 text-tavern-danger'
        )}>
          {testResult.success ? '✓ ' : '✗ '}{testResult.message}
        </div>
      )}
    </div>
  )

  return (
    <div className="space-y-2">
      {models.length === 0 && !showAdd ? (
        <div className="text-center py-8">
          <Image className="w-10 h-10 text-tavern-text-muted mx-auto mb-2 opacity-30" />
          <p className="text-sm text-tavern-text-muted mb-3">尚未配置生图模型</p>
          <button onClick={openAdd} className="btn-primary inline-flex items-center gap-1.5 text-xs">
            <Plus className="w-3.5 h-3.5" />添加生图模型
          </button>
        </div>
      ) : (
        <>
          {models.map((m, idx) => (
            <div
              key={m.id}
              className={cn(
                'rounded-xl border transition-colors',
                m.id === settings.activeImageGenModelId
                  ? 'border-tavern-accent bg-tavern-accent-soft/30'
                  : 'border-tavern-border-soft bg-tavern-bg-card'
              )}
            >
              <div
                className="flex items-center gap-2 px-3 py-2.5 cursor-pointer hover:bg-tavern-bg-hover/50 rounded-t-xl"
                onClick={() => {
                  if (editingId === m.id) { setEditingId(null); resetForm() }
                  else openEdit(m)
                }}
              >
                <div className="flex items-center gap-1">
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

                <Circle
                  className={cn(
                    'w-3 h-3 shrink-0',
                    m.id === settings.activeImageGenModelId
                      ? 'text-tavern-success fill-current'
                      : 'text-tavern-text-muted'
                  )}
                />

                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-tavern-text truncate">{m.name}</div>
                  <div className="text-xs text-tavern-text-muted">
                    {m.provider}
                    {m.model ? ` · ${m.model}` : ''}
                    {m.size ? ` · ${m.size}` : ''}
                    {m.provider === 'openai' && m.quality ? ` · ${m.quality}` : ''}
                    {m.provider === 'sd-webui' && m.steps ? ` · ${m.steps}步` : ''}
                  </div>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  {m.id === settings.activeImageGenModelId ? (
                    <span className="text-xs px-2 py-0.5 rounded bg-tavern-accent-soft text-tavern-accent font-medium">
                      使用中
                    </span>
                  ) : (
                    <button
                      onClick={(e) => { e.stopPropagation(); setActiveImageGenModelId(m.id) }}
                      className="text-xs px-2 py-0.5 rounded border border-tavern-border-soft text-tavern-text-muted hover:text-tavern-accent hover:border-tavern-accent transition-colors"
                    >
                      启用
                    </button>
                  )}
                </div>
              </div>

              {editingId === m.id && (
                <div className="px-4 pb-4 pt-1 border-t border-tavern-border-soft">
                  <div className="flex items-center justify-end mb-2">
                    <button
                      onClick={() => handleDelete(m.id)}
                      className="p-1.5 rounded text-tavern-text-muted hover:text-tavern-danger hover:bg-tavern-danger/10 transition-colors"
                      title="删除"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  {renderForm()}
                </div>
              )}
            </div>
          ))}

          {showAdd && (
            <div className="rounded-xl border border-tavern-accent bg-tavern-accent-soft/20">
              <div className="px-4 py-3 border-b border-tavern-border-soft flex items-center gap-2 text-sm font-medium text-tavern-accent">
                <Plus className="w-4 h-4" />新建生图配置
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
              <span className="text-sm">添加生图模型</span>
            </button>
          )}
        </>
      )}
    </div>
  )
}
