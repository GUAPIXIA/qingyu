import { useEffect, useMemo, useState } from 'react'
import { nanoid } from 'nanoid'
import { Modal } from '../components/common/Modal'
import { EmptyState } from '../components/common/EmptyState'
import { ConfirmDialog } from '../components/common/ConfirmDialog'
import { Sliders, Plus, Upload, Trash2, Shield, Copy, Download, ChevronDown, ChevronRight } from 'lucide-react'
import { BUILTIN_TEMPLATE_NAMES } from '../utils/chatTemplates'
import type { Preset } from '../../shared/types'

/** 模板名 → 展示标签 */
const TEMPLATE_LABELS: Record<string, string> = {
  chatml: 'ChatML（Qwen/DeepSeek）',
  qwen: 'Qwen（ChatML）',
  deepseek: 'DeepSeek（ChatML）',
  llama2: 'Llama 2',
  llama3: 'Llama 3',
  mistral: 'Mistral',
  phi3: 'Phi-3',
  alpaca: 'Alpaca',
  gemma: 'Gemma',
  'command-r': 'Command R',
}

function createPreset(): Preset {
  return {
    id: nanoid(),
    name: '新建预设',
    description: '',
    systemPrompt: '',
    jailbreak: '',
    maxContext: 0, // 0 = 跟随模型默认
    temperature: 0.8,
    topP: 0.95,
    maxTokens: 1024,
    frequencyPenalty: 0,
    presencePenalty: 0,
    isBuiltin: false,
    contextTemplate: '',
    group: '',
  }
}

/** 分组键：空 group 归入「未分组」 */
function groupKey(preset: Preset): string {
  return preset.group?.trim() || '未分组'
}

export function PresetsPage() {
  const [presets, setPresets] = useState<Preset[]>([])
  const [editingPreset, setEditingPreset] = useState<Preset | null>(null)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const [busyMsg, setBusyMsg] = useState<string | null>(null)

  const loadPresets = () => {
    window.api.preset.list().then(setPresets)
  }

  useEffect(() => {
    loadPresets()
  }, [])

  /** 按分组聚合（保留组出现顺序） */
  const grouped = useMemo(() => {
    const map = new Map<string, Preset[]>()
    for (const preset of presets) {
      const key = groupKey(preset)
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(preset)
    }
    return [...map.entries()]
  }, [presets])

  const toggleGroup = (key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const handleNew = () => {
    setEditingPreset(createPreset())
  }

  const handleImport = async () => {
    const imported = await window.api.preset.importJson()
    if (imported) loadPresets()
  }

  /** 一键复制：基于任意预设（含内置）创建可编辑副本 */
  const handleDuplicate = async (preset: Preset) => {
    const copy: Preset = {
      ...preset,
      id: nanoid(),
      name: `${preset.name} (副本)`,
      isBuiltin: false,
    }
    await window.api.preset.save(copy)
    loadPresets()
  }

  /** 导出单个预设 JSON */
  const handleExport = async (preset: Preset) => {
    setBusyMsg(`正在导出「${preset.name}」...`)
    try {
      const r = await window.api.preset.exportJson(preset.id)
      if (r.error) setBusyMsg(`导出失败：${r.error}`)
      else setBusyMsg(null)
    } finally {
      setBusyMsg(null)
    }
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
          <div className="max-w-5xl mx-auto space-y-4">
            {busyMsg && <div className="text-sm text-tavern-text-muted">{busyMsg}</div>}
            {grouped.map(([group, groupPresets]) => {
              const collapsed = collapsedGroups.has(group)
              return (
                <div key={group}>
                  <button
                    onClick={() => toggleGroup(group)}
                    className="flex items-center gap-1.5 text-sm font-medium text-tavern-text-muted hover:text-tavern-text w-full mb-2"
                  >
                    {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    <span>{group}</span>
                    <span className="text-xs text-tavern-text-muted/60">（{groupPresets.length} 个）</span>
                  </button>
                  {!collapsed && (
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                      {groupPresets.map((preset) => (
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
                            <div className="flex items-center gap-0.5 shrink-0">
                              {/* 复制 */}
                              <button
                                className="btn-ghost p-1.5 text-tavern-text-muted hover:text-tavern-accent shrink-0"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  handleDuplicate(preset)
                                }}
                                title="复制为新预设"
                              >
                                <Copy className="w-3.5 h-3.5" />
                              </button>
                              {/* 导出 */}
                              <button
                                className="btn-ghost p-1.5 text-tavern-text-muted hover:text-tavern-accent shrink-0"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  handleExport(preset)
                                }}
                                title="导出 JSON"
                              >
                                <Download className="w-3.5 h-3.5" />
                              </button>
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
                              上下文 {preset.maxContext > 0 ? preset.maxContext : '跟随模型'}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
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
                <label className="label">分组</label>
                <input
                  className="input"
                  list="preset-groups"
                  value={editingPreset.group ?? ''}
                  onChange={(e) => updateField('group', e.target.value)}
                  placeholder="如：通用 / 越狱 / 风格特化"
                />
                <datalist id="preset-groups">
                  {grouped.map(([g]) => <option key={g} value={g} />)}
                </datalist>
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

            <div>
              <label className="label">上下文模板（Ollama 本地模型用）</label>
              <select
                className="select"
                value={editingPreset.contextTemplate || ''}
                onChange={(e) => updateField('contextTemplate', e.target.value || undefined)}
              >
                <option value="">不启用（消息数组直发）</option>
                {BUILTIN_TEMPLATE_NAMES.map((name) => (
                  <option key={name} value={name}>{TEMPLATE_LABELS[name] ?? name}</option>
                ))}
              </select>
              <p className="text-xs text-tavern-text-muted mt-1">启用后 Ollama 改用纯文本接口 + 模板包装，适合 chat template 缺失/异常的本地模型；Qwen / DeepSeek 选 ChatML</p>
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
                <label className="label">上下文长度（0 = 跟随模型）</label>
                <input
                  type="number"
                  min={0}
                  className="input"
                  value={editingPreset.maxContext}
                  onChange={(e) => updateField('maxContext', Number(e.target.value) || 0)}
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
