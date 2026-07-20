import { useEffect, useState } from 'react'
import { nanoid } from 'nanoid'
import { Modal } from '../components/common/Modal'
import { EmptyState } from '../components/common/EmptyState'
import { ConfirmDialog } from '../components/common/ConfirmDialog'
import { cn } from '../lib/utils'
import { Sliders, Plus, Upload, Trash2, Shield } from 'lucide-react'
import type { Preset } from '../../shared/types'

function createPreset(): Preset {
  return {
    id: nanoid(),
    name: '新建预设',
    description: '',
    systemPrompt: '',
    jailbreak: '',
    maxContext: 8192,
    temperature: 0.8,
    topP: 0.95,
    maxTokens: 1024,
    frequencyPenalty: 0,
    presencePenalty: 0,
    isBuiltin: false,
  }
}

export function PresetsPage() {
  const [presets, setPresets] = useState<Preset[]>([])
  const [editingPreset, setEditingPreset] = useState<Preset | null>(null)
  const [deleteId, setDeleteId] = useState<string | null>(null)

  const loadPresets = () => {
    window.api.preset.list().then(setPresets)
  }

  useEffect(() => {
    loadPresets()
  }, [])

  const handleNew = () => {
    setEditingPreset(createPreset())
  }

  const handleImport = async () => {
    const imported = await window.api.preset.importJson()
    if (imported) loadPresets()
  }

  const handleEdit = (preset: Preset) => {
    setEditingPreset({ ...preset })
  }

  const handleSave = async () => {
    if (!editingPreset) return
    // 内置预设保存时后端会自动创建副本并返回新 preset
    const saved = (await window.api.preset.save(editingPreset)) as unknown as Preset
    setEditingPreset(saved)
    loadPresets()
  }

  const handleDelete = async () => {
    if (!deleteId) return
    await window.api.preset.delete(deleteId)
    setDeleteId(null)
    loadPresets()
  }

  const updateField = <K extends keyof Preset>(key: K, value: Preset[K]) => {
    setEditingPreset((prev) => (prev ? { ...prev, [key]: value } : prev))
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* 顶栏 */}
      <header className="flex items-center justify-between px-4 h-14 border-b border-tavern-border-soft bg-tavern-bg-soft shrink-0">
        <h1 className="font-display text-lg font-bold">预设</h1>
        <div className="flex items-center gap-2">
          <button onClick={handleNew} className="btn-primary">
            <Plus className="w-4 h-4" />
            新建
          </button>
          <button onClick={handleImport} className="btn-secondary">
            <Upload className="w-4 h-4" />
            导入
          </button>
        </div>
      </header>

      {/* 预设列表 */}
      <div className="flex-1 overflow-y-auto p-4">
        {presets.length === 0 ? (
          <EmptyState
            className="h-full"
            icon={<Sliders className="w-8 h-8" />}
            title="还没有预设"
            description="创建你的第一个预设，配置 AI 的生成参数和提示词"
            action={
              <div className="flex gap-2">
                <button className="btn-primary" onClick={handleNew}>
                  <Plus className="w-4 h-4" />
                  新建预设
                </button>
                <button className="btn-secondary" onClick={handleImport}>
                  <Upload className="w-4 h-4" />
                  导入预设
                </button>
              </div>
            }
          />
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {presets.map((preset) => (
              <div
                key={preset.id}
                onClick={() => handleEdit(preset)}
                className="card p-4 cursor-pointer hover:bg-tavern-bg-hover transition-colors"
              >
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <Sliders className="w-4 h-4 text-tavern-accent shrink-0" />
                    <h3 className="font-medium text-tavern-text truncate">{preset.name}</h3>
                    {preset.isBuiltin && (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-tavern-accent-soft text-tavern-accent text-xs shrink-0">
                        <Shield className="w-3 h-3" />
                        内置
                      </span>
                    )}
                  </div>
                  {!preset.isBuiltin && (
                    <button
                      className="btn-ghost p-1.5 text-tavern-danger shrink-0"
                      onClick={(e) => {
                        e.stopPropagation()
                        setDeleteId(preset.id)
                      }}
                      title="删除"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
                <p className="text-xs text-tavern-text-muted line-clamp-2 mb-3 min-h-[2rem]">
                  {preset.description || '无描述'}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  <span className="px-1.5 py-0.5 rounded bg-tavern-bg-hover text-tavern-text-soft text-xs">
                    温度 {preset.temperature}
                  </span>
                  <span className="px-1.5 py-0.5 rounded bg-tavern-bg-hover text-tavern-text-soft text-xs">
                    TopP {preset.topP}
                  </span>
                  <span className="px-1.5 py-0.5 rounded bg-tavern-bg-hover text-tavern-text-soft text-xs">
                    Token {preset.maxTokens}
                  </span>
                  <span className="px-1.5 py-0.5 rounded bg-tavern-bg-hover text-tavern-text-soft text-xs">
                    上下文 {preset.maxContext}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 编辑 Modal */}
      <Modal
        open={!!editingPreset}
        onClose={() => setEditingPreset(null)}
        title={editingPreset?.isBuiltin ? '查看预设（保存后创建副本）' : '编辑预设'}
        width="xl"
        footer={
          <>
            <button className="btn-secondary" onClick={() => setEditingPreset(null)}>
              关闭
            </button>
            <button className="btn-primary" onClick={handleSave}>
              保存
            </button>
          </>
        }
      >
        {editingPreset && (
          <div className="space-y-4">
            {editingPreset.isBuiltin && (
              <div className="px-3 py-2 rounded-lg bg-tavern-accent-soft text-tavern-accent text-xs flex items-center gap-2">
                <Shield className="w-4 h-4" />
                这是内置预设，保存后将自动创建一个可编辑的副本。
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label">名称</label>
                <input
                  className="input"
                  value={editingPreset.name}
                  onChange={(e) => updateField('name', e.target.value)}
                />
              </div>
              <div>
                <label className="label">描述</label>
                <input
                  className="input"
                  value={editingPreset.description}
                  onChange={(e) => updateField('description', e.target.value)}
                />
              </div>
            </div>

            <div>
              <label className="label">System Prompt</label>
              <textarea
                className="textarea h-28"
                placeholder="系统提示词..."
                value={editingPreset.systemPrompt}
                onChange={(e) => updateField('systemPrompt', e.target.value)}
              />
            </div>

            <div>
              <label className="label">Jailbreak</label>
              <textarea
                className="textarea h-20"
                placeholder="越狱提示词（可选）..."
                value={editingPreset.jailbreak}
                onChange={(e) => updateField('jailbreak', e.target.value)}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label">温度：{editingPreset.temperature}</label>
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={0.1}
                  value={editingPreset.temperature}
                  onChange={(e) => updateField('temperature', Number(e.target.value))}
                  className="w-full accent-tavern-accent"
                />
              </div>
              <div>
                <label className="label">Top P：{editingPreset.topP}</label>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={editingPreset.topP}
                  onChange={(e) => updateField('topP', Number(e.target.value))}
                  className="w-full accent-tavern-accent"
                />
              </div>
              <div>
                <label className="label">最大 Token</label>
                <input
                  type="number"
                  min={1}
                  className="input"
                  value={editingPreset.maxTokens}
                  onChange={(e) => updateField('maxTokens', Number(e.target.value) || 1)}
                />
              </div>
              <div>
                <label className="label">上下文长度</label>
                <input
                  type="number"
                  min={1}
                  className="input"
                  value={editingPreset.maxContext}
                  onChange={(e) => updateField('maxContext', Number(e.target.value) || 1)}
                />
              </div>
              <div>
                <label className="label">频率惩罚：{editingPreset.frequencyPenalty}</label>
                <input
                  type="range"
                  min={-2}
                  max={2}
                  step={0.1}
                  value={editingPreset.frequencyPenalty}
                  onChange={(e) => updateField('frequencyPenalty', Number(e.target.value))}
                  className="w-full accent-tavern-accent"
                />
              </div>
              <div>
                <label className="label">存在惩罚：{editingPreset.presencePenalty}</label>
                <input
                  type="range"
                  min={-2}
                  max={2}
                  step={0.1}
                  value={editingPreset.presencePenalty}
                  onChange={(e) => updateField('presencePenalty', Number(e.target.value))}
                  className="w-full accent-tavern-accent"
                />
              </div>
            </div>
          </div>
        )}
      </Modal>

      {/* 删除确认 */}
      <ConfirmDialog
        open={!!deleteId}
        onClose={() => setDeleteId(null)}
        onConfirm={handleDelete}
        title="删除预设"
        message="确定要删除这个预设吗？此操作不可撤销。"
        confirmText="删除"
        danger
      />
    </div>
  )
}
