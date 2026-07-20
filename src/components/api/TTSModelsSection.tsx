import { useState } from 'react'
import { useSettingsStore } from '../../store/useSettingsStore'
import { cn } from '../../lib/utils'
import type { TTSModelConfig } from '../../../shared/types'
import {
  Volume2, Plus, Edit3, Trash2, Check, X, Eye, EyeOff,
  Circle, ChevronUp, ChevronDown, GripVertical,
} from 'lucide-react'

const TTS_PROVIDERS = [
  { value: 'edge' as const, label: 'Edge TTS (本地)', desc: 'Windows 系统自带' },
  { value: 'openai' as const, label: 'OpenAI TTS', desc: '需 API Key' },
]

function emptyForm(): TTSModelConfig {
  return {
    id: '', name: '', provider: 'edge' as const,
    model: '', voice: '', apiKey: '', baseUrl: '',
    enabled: true, order: 0,
  }
}

export function TTSModelsSection() {
  const {
    settings, addTTSModel, updateTTSModel, deleteTTSModel,
    setActiveTTSModelId, reorderTTSModels,
  } = useSettingsStore()

  const [editingId, setEditingId] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const [form, setForm] = useState<TTSModelConfig>(emptyForm())

  const models = [...settings.ttsModels].sort((a, b) => a.order - b.order)

  const resetForm = () => {
    setForm(emptyForm())
    setShowKey(false)
  }

  const openEdit = (m: TTSModelConfig) => {
    setForm({ ...m })
    setEditingId(m.id)
    setShowAdd(false)
    setShowKey(false)
  }

  const openAdd = () => {
    resetForm()
    setEditingId(null)
    setShowAdd(true)
  }

  const handleSave = () => {
    if (!form.name.trim()) return
    if (editingId) {
      updateTTSModel(editingId, form)
      setEditingId(null)
    } else {
      addTTSModel(form)
      setShowAdd(false)
    }
    resetForm()
  }

  const handleDelete = (id: string) => {
    deleteTTSModel(id)
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
    reorderTTSModels(newModels.map((m) => m.id))
  }

  const renderForm = () => (
    <div className="space-y-3 mt-3">
      {/* 名称 */}
      <input
        type="text"
        className="input text-sm"
        value={form.name}
        onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
        placeholder="配置名称（如：Edge 中文女声）"
        autoFocus
      />

      {/* 提供商选择 */}
      <div>
        <label className="label">TTS 提供商</label>
        <div className="flex flex-wrap gap-1.5">
          {TTS_PROVIDERS.map((pr) => (
            <button
              key={pr.value}
              onClick={() => setForm((f) => ({ ...f, provider: pr.value }))}
              className={cn(
                'px-2.5 py-1 rounded text-xs border transition-colors',
                form.provider === pr.value
                  ? 'border-tavern-accent bg-tavern-accent-soft text-tavern-accent'
                  : 'border-tavern-border-soft bg-tavern-bg-soft text-tavern-text-soft hover:border-tavern-border'
              )}
              title={pr.desc}
            >
              {pr.label}
            </button>
          ))}
        </div>
      </div>

      {/* OpenAI 特有字段 */}
      {form.provider === 'openai' && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="label">Base URL</label>
              <input
                type="text"
                className="input text-xs font-mono"
                value={form.baseUrl}
                onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
                placeholder="https://api.openai.com/v1"
              />
            </div>
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
          </div>
          <div>
            <label className="label">模型名称</label>
            <input
              type="text"
              className="input text-sm"
              value={form.model}
              onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
              placeholder="例如 tts-1、tts-1-hd"
            />
          </div>
        </>
      )}

      {/* 语音 */}
      <div>
        <label className="label">语音 ID</label>
        <input
          type="text"
          className="input text-sm"
          value={form.voice}
          onChange={(e) => setForm((f) => ({ ...f, voice: e.target.value }))}
          placeholder={form.provider === 'edge' ? '例如 zh-CN-XiaoxiaoNeural' : '例如 alloy、nova'}
        />
        {form.provider === 'edge' && (
          <p className="text-xs text-tavern-text-muted mt-1">
            可使用 PowerShell 命令 <code className="text-tavern-accent text-[11px]">Get-WinUserLanguageList</code> 查看可用语音
          </p>
        )}
      </div>

      {/* 操作按钮 */}
      <div className="flex items-center gap-2">
        <button onClick={handleSave} disabled={!form.name.trim()} className="btn-primary text-xs">
          <Check className="w-3.5 h-3.5" />保存
        </button>
        <button
          onClick={() => { editingId ? setEditingId(null) : setShowAdd(false); resetForm() }}
          className="px-3 py-1.5 text-xs text-tavern-text-muted hover:text-tavern-text"
        >
          取消
        </button>
      </div>
    </div>
  )

  return (
    <div className="space-y-2">
      {models.length === 0 && !showAdd ? (
        <div className="text-center py-8">
          <Volume2 className="w-10 h-10 text-tavern-text-muted mx-auto mb-2 opacity-30" />
          <p className="text-sm text-tavern-text-muted mb-3">尚未配置 TTS 模型</p>
          <button onClick={openAdd} className="btn-primary inline-flex items-center gap-1.5 text-xs">
            <Plus className="w-3.5 h-3.5" />添加 TTS 模型
          </button>
        </div>
      ) : (
        <>
          {models.map((m, idx) => (
            <div
              key={m.id}
              className={cn(
                'rounded-xl border transition-colors',
                m.id === settings.activeTTSModelId
                  ? 'border-tavern-accent bg-tavern-accent-soft/30'
                  : 'border-tavern-border-soft bg-tavern-bg-card'
              )}
            >
              {/* 折叠头部 */}
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
                    m.id === settings.activeTTSModelId
                      ? 'text-tavern-success fill-current'
                      : 'text-tavern-text-muted'
                  )}
                />

                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-tavern-text truncate">{m.name}</div>
                  <div className="text-xs text-tavern-text-muted">
                    {m.provider === 'edge' ? 'Edge TTS' : 'OpenAI TTS'}
                    {m.voice ? ` · ${m.voice}` : ''}
                    {m.model ? ` · ${m.model}` : ''}
                  </div>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  {m.id === settings.activeTTSModelId ? (
                    <span className="text-xs px-2 py-0.5 rounded bg-tavern-accent-soft text-tavern-accent font-medium">
                      使用中
                    </span>
                  ) : (
                    <button
                      onClick={(e) => { e.stopPropagation(); setActiveTTSModelId(m.id) }}
                      className="text-xs px-2 py-0.5 rounded border border-tavern-border-soft text-tavern-text-muted hover:text-tavern-accent hover:border-tavern-accent transition-colors"
                    >
                      启用
                    </button>
                  )}
                </div>
              </div>

              {/* 编辑区 */}
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

          {/* 新建表单 */}
          {showAdd && (
            <div className="rounded-xl border border-tavern-accent bg-tavern-accent-soft/20">
              <div className="px-4 py-3 border-b border-tavern-border-soft flex items-center gap-2 text-sm font-medium text-tavern-accent">
                <Plus className="w-4 h-4" />新建 TTS 配置
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
              <span className="text-sm">添加 TTS 模型</span>
            </button>
          )}
        </>
      )}
    </div>
  )
}
