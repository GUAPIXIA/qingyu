import { useState } from 'react'
import { useSettingsStore } from '../../store/useSettingsStore'
import { cn } from '../../lib/utils'
import type { VisionModelConfig } from '../../../shared/types'
import {
  Eye, Plus, Trash2, Check,
  Circle, ChevronUp, ChevronDown,
} from 'lucide-react'

function emptyForm(): VisionModelConfig {
  return { id: '', name: '', model: '', enabled: true, order: 0 }
}

export function VisionModelsSection() {
  const {
    settings, addVisionModel, updateVisionModel, deleteVisionModel,
    setActiveVisionModelId, reorderVisionModels,
  } = useSettingsStore()

  const [editingId, setEditingId] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [form, setForm] = useState<VisionModelConfig>(emptyForm())

  const models = [...settings.visionModels].sort((a, b) => a.order - b.order)

  const resetForm = () => setForm(emptyForm())

  const openEdit = (m: VisionModelConfig) => {
    setForm({ ...m })
    setEditingId(m.id)
    setShowAdd(false)
  }

  const openAdd = () => {
    resetForm()
    setEditingId(null)
    setShowAdd(true)
  }

  const handleSave = () => {
    if (!form.name.trim()) return
    if (editingId) {
      updateVisionModel(editingId, form)
      setEditingId(null)
    } else {
      addVisionModel(form)
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

  const renderForm = () => (
    <div className="space-y-3 mt-3">
      <input
        type="text"
        className="input text-sm"
        value={form.name}
        onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
        placeholder="配置名称（如：GPT-4o 识图）"
        autoFocus
      />

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
          识图功能使用当前对话 API 的连接配置，此处只需指定模型名称
        </p>
      </div>

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
                    m.id === settings.activeVisionModelId
                      ? 'text-tavern-success fill-current'
                      : 'text-tavern-text-muted'
                  )}
                />

                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-tavern-text truncate">{m.name}</div>
                  <div className="text-xs text-tavern-text-muted">
                    {m.model || '未指定模型'}
                  </div>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  {m.id === settings.activeVisionModelId ? (
                    <span className="text-xs px-2 py-0.5 rounded bg-tavern-accent-soft text-tavern-accent font-medium">
                      使用中
                    </span>
                  ) : (
                    <button
                      onClick={(e) => { e.stopPropagation(); setActiveVisionModelId(m.id) }}
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
