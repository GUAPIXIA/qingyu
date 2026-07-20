import { useEffect, useState } from 'react'
import { nanoid } from 'nanoid'
import { EmptyState } from '../components/common/EmptyState'
import { ConfirmDialog } from '../components/common/ConfirmDialog'
import { cn } from '../lib/utils'
import {
  BookOpen,
  BookMarked,
  Plus,
  Upload,
  Trash2,
  Pencil,
  Languages,
  Loader2,
  CheckCircle,
  AlertCircle,
  Copy,
  ChevronDown,
  ChevronUp,
} from 'lucide-react'
import { useSettingsStore } from '../store/useSettingsStore'
import type { Lorebook, LoreEntry } from '../../shared/types'

const POSITION_LABELS: Record<LoreEntry['position'], string> = {
  before_char: '角色定义前',
  after_char: '角色定义后',
  at_end: '消息末尾',
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
        checked ? 'bg-tavern-accent' : 'bg-tavern-bg-hover'
      )}
    >
      <span
        className={cn(
          'inline-block h-4 w-4 transform rounded-full bg-white transition-transform',
          checked ? 'translate-x-4' : 'translate-x-0.5'
        )}
      />
    </button>
  )
}

function createLorebook(): Lorebook {
  return {
    id: nanoid(),
    name: '新建世界书',
    description: '',
    entries: [],
    enabled: true,
    scanDepth: 4,
  }
}

function createEntry(): LoreEntry {
  return {
    id: nanoid(),
    keywords: [],
    content: '',
    position: 'before_char',
    order: 100,
    probability: 100,
    enabled: true,
  }
}

export function LorebookPage() {
  const [lorebooks, setLorebooks] = useState<Lorebook[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editingEntry, setEditingEntry] = useState<LoreEntry | null>(null)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [deleteEntryId, setDeleteEntryId] = useState<string | null>(null)
  const [expandedEntries, setExpandedEntries] = useState<Set<string>>(new Set())
  /** AI 翻译状态：key 为字段标识 */
  const [translatingField, setTranslatingField] = useState<{ key: string; text: string } | null>(null)
  const [translateResult, setTranslateResult] = useState<string | null>(null)

  const { getActiveProfile, settings } = useSettingsStore()

  const selected = lorebooks.find((l) => l.id === selectedId) ?? null

  useEffect(() => {
    window.api.lorebook.list().then((list) => {
      setLorebooks(list)
      if (list.length > 0) setSelectedId(list[0].id)
    })
  }, [])

  const updateLorebook = (id: string, patch: Partial<Lorebook>) => {
    const current = lorebooks.find((l) => l.id === id)
    if (!current) return
    const updated: Lorebook = { ...current, ...patch }
    setLorebooks((prev) => prev.map((l) => (l.id === id ? updated : l)))
    window.api.lorebook.save(updated)
  }

  const handleNew = () => {
    const lb = createLorebook()
    setLorebooks((prev) => [...prev, lb])
    setSelectedId(lb.id)
    setEditingEntry(null)
    window.api.lorebook.save(lb)
  }

  const handleImport = async () => {
    const imported = await window.api.lorebook.importJson()
    if (imported) {
      setLorebooks((prev) => [...prev, imported])
      setSelectedId(imported.id)
      setEditingEntry(null)
    }
  }

  const handleDelete = async () => {
    if (!deleteId) return
    await window.api.lorebook.delete(deleteId)
    setLorebooks((prev) => prev.filter((l) => l.id !== deleteId))
    if (selectedId === deleteId) setSelectedId(null)
    setDeleteId(null)
  }

  const handleNewEntry = () => {
    setEditingEntry(createEntry())
  }

  const handleEditEntry = (entry: LoreEntry) => {
    setEditingEntry({ ...entry })
  }

  const handleSaveEntry = () => {
    if (!editingEntry || !selected) return
    const exists = selected.entries.some((e) => e.id === editingEntry.id)
    const entries = exists
      ? selected.entries.map((e) => (e.id === editingEntry.id ? editingEntry : e))
      : [...selected.entries, editingEntry]
    updateLorebook(selected.id, { entries })
    setEditingEntry(null)
  }

  const handleDeleteEntry = () => {
    if (!deleteEntryId || !selected) return
    const entries = selected.entries.filter((e) => e.id !== deleteEntryId)
    updateLorebook(selected.id, { entries })
    if (editingEntry?.id === deleteEntryId) setEditingEntry(null)
    setDeleteEntryId(null)
  }

  /** AI 翻译文本并在目标字段中应用 */
  const handleAiTranslate = async (text: string, fieldKey: string, onApply: (translated: string) => void) => {
    if (!text.trim() || translatingField) return
    const profile = getActiveProfile()
    if (!profile) return

    setTranslatingField({ key: fieldKey, text })
    setTranslateResult(null)

    const requestId = `lorebook-translate-${Date.now()}`
    let result = ''

    const unbindChunk = window.api.ai.onChunk((data) => {
      if (data.requestId !== requestId) return
      result += data.text
      setTranslateResult(result)
    })
    const unbindDone = window.api.ai.onDone((doneId) => {
      if (doneId !== requestId) return
      unbindChunk(); unbindDone(); unbindError()
      setTranslatingField(null)
      setTranslateResult(null)
      if (result.trim()) {
        onApply(result.trim())
      }
    })
    const unbindError = window.api.ai.onError((data) => {
      if (data.requestId !== requestId) return
      unbindChunk(); unbindDone(); unbindError()
      setTranslatingField(null)
      setTranslateResult(null)
    })

    window.api.ai.chat({
      requestId,
      messages: [
        { role: 'system', content: '你是一个翻译助手。请将以下文本翻译成中文。只输出翻译结果，不要添加任何解释或额外内容。保留原文中的标点符号风格。' },
        { role: 'user', content: text },
      ],
      provider: profile.provider,
      apiKey: profile.apiKey,
      baseUrl: profile.baseUrl,
      model: settings.activeModel || profile.model,
      temperature: 0.3,
      topP: 0.9,
      maxTokens: 2048,
      frequencyPenalty: 0,
      presencePenalty: 0,
      stream: true,
    }).catch(() => {
      unbindChunk(); unbindDone(); unbindError()
      setTranslatingField(null)
      setTranslateResult(null)
    })
  }

  const toggleEntryExpand = (entryId: string) => {
    setExpandedEntries((prev) => {
      const next = new Set(prev)
      if (next.has(entryId)) next.delete(entryId)
      else next.add(entryId)
      return next
    })
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* 顶栏 */}
      <header className="flex items-center justify-between px-4 h-14 border-b border-tavern-border-soft bg-tavern-bg-soft shrink-0">
        <h1 className="font-display text-lg font-bold">世界书</h1>
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

      {lorebooks.length === 0 ? (
        <EmptyState
          className="h-full"
          icon={<BookOpen className="w-8 h-8" />}
          title="还没有世界书"
          description="创建你的第一本世界书，为角色扮演添加丰富的世界观设定"
          action={
            <div className="flex gap-2">
              <button className="btn-primary" onClick={handleNew}>
                <Plus className="w-4 h-4" />
                新建世界书
              </button>
              <button className="btn-secondary" onClick={handleImport}>
                <Upload className="w-4 h-4" />
                导入世界书
              </button>
            </div>
          }
        />
      ) : (
        <div className="flex-1 flex overflow-hidden">
          {/* 左侧列表 */}
          <aside className="w-72 border-r border-tavern-border-soft overflow-y-auto p-3 space-y-2 shrink-0">
            {lorebooks.map((lb) => (
              <div
                key={lb.id}
                onClick={() => {
                  setSelectedId(lb.id)
                  setEditingEntry(null)
                }}
                className={cn(
                  'card p-3 cursor-pointer transition-colors',
                  lb.id === selectedId
                    ? 'border-tavern-accent ring-1 ring-tavern-accent'
                    : 'hover:bg-tavern-bg-hover'
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <BookMarked className="w-4 h-4 text-tavern-accent shrink-0" />
                      <span className="font-medium text-sm text-tavern-text truncate">
                        {lb.name}
                      </span>
                    </div>
                    <p className="text-xs text-tavern-text-muted mt-1 line-clamp-2">
                      {lb.description || '无描述'}
                    </p>
                    <div className="text-xs text-tavern-text-muted mt-1.5">
                      {lb.entries.length} 个条目
                    </div>
                  </div>
                  <div onClick={(e) => e.stopPropagation()}>
                    <Toggle
                      checked={lb.enabled}
                      onChange={(v) => updateLorebook(lb.id, { enabled: v })}
                    />
                  </div>
                </div>
              </div>
            ))}
          </aside>

          {/* 右侧编辑区 */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {!selected ? (
              <EmptyState
                className="h-full"
                icon={<BookOpen className="w-8 h-8" />}
                title="选择一本世界书"
                description="从左侧选择一本世界书来编辑其条目"
              />
            ) : (
              <>
                {/* 世界书信息 */}
                <div className="p-4 border-b border-tavern-border-soft space-y-3 shrink-0">
                  <div className="flex items-start gap-3">
                    <div className="flex-1 grid grid-cols-2 gap-3">
                      <div>
                        <label className="label">名称</label>
                        <div className="flex gap-1.5">
                          <input
                            className="input flex-1"
                            value={selected.name}
                            onChange={(e) => updateLorebook(selected.id, { name: e.target.value })}
                          />
                          <button
                            className="btn-ghost p-1.5 shrink-0"
                            title="AI 翻译名称"
                            disabled={!!translatingField}
                            onClick={() => handleAiTranslate(selected.name, `name-${selected.id}`, (translated) => {
                              updateLorebook(selected.id, { name: translated })
                            })}
                          >
                            {translatingField?.key === `name-${selected.id}` ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <Languages className="w-3.5 h-3.5" />
                            )}
                          </button>
                        </div>
                      </div>
                      <div>
                        <label className="label">扫描深度（最近 N 条消息）</label>
                        <input
                          type="number"
                          min={1}
                          className="input"
                          value={selected.scanDepth}
                          onChange={(e) =>
                            updateLorebook(selected.id, {
                              scanDepth: Number(e.target.value) || 1,
                            })
                          }
                        />
                      </div>
                    </div>
                    <div className="flex items-center gap-2 pt-6">
                      <span className="text-sm text-tavern-text-soft">启用</span>
                      <Toggle
                        checked={selected.enabled}
                        onChange={(v) => updateLorebook(selected.id, { enabled: v })}
                      />
                      <button
                        className="btn-danger"
                        onClick={() => setDeleteId(selected.id)}
                        title="删除世界书"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className="label">描述</label>
                    <div className="flex gap-1.5">
                      <input
                        className="input flex-1"
                        value={selected.description}
                        onChange={(e) =>
                          updateLorebook(selected.id, { description: e.target.value })
                        }
                      />
                      <button
                        className="btn-ghost p-1.5 shrink-0"
                        title="AI 翻译描述"
                        disabled={!!translatingField || !selected.description}
                        onClick={() => handleAiTranslate(selected.description, `desc-${selected.id}`, (translated) => {
                          updateLorebook(selected.id, { description: translated })
                        })}
                      >
                        {translatingField?.key === `desc-${selected.id}` ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Languages className="w-3.5 h-3.5" />
                        )}
                      </button>
                    </div>
                  </div>
                </div>

                {/* 条目列表 */}
                <div className="flex-1 overflow-y-auto p-4">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="font-medium text-sm text-tavern-text">
                      条目（{selected.entries.length}）
                    </h3>
                    <button className="btn-secondary" onClick={handleNewEntry}>
                      <Plus className="w-4 h-4" />
                      新建条目
                    </button>
                  </div>
                  {selected.entries.length === 0 ? (
                    <div className="text-center py-10 text-sm text-tavern-text-muted">
                      暂无条目，点击「新建条目」开始添加
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {selected.entries.map((entry) => (
                        <div key={entry.id} className="card p-3">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap gap-1 mb-1.5">
                                {entry.keywords.length === 0 ? (
                                  <span className="text-xs text-tavern-text-muted">无关键词</span>
                                ) : (
                                  entry.keywords.map((k, i) => (
                                    <span
                                      key={i}
                                      className="px-1.5 py-0.5 rounded bg-tavern-accent-soft text-tavern-accent text-xs"
                                    >
                                      {k}
                                    </span>
                                  ))
                                )}
                              </div>
                              <div className="flex items-center gap-2">
                                <button
                                  onClick={() => toggleEntryExpand(entry.id)}
                                  className="text-xs text-tavern-text-muted hover:text-tavern-text flex items-center gap-0.5"
                                  title={expandedEntries.has(entry.id) ? '收起内容' : '展开内容'}
                                >
                                  {expandedEntries.has(entry.id) ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                                </button>
                                <p className={cn(
                                  'text-xs text-tavern-text-soft',
                                  expandedEntries.has(entry.id) ? '' : 'line-clamp-2'
                                )}>
                                  {entry.content || '无内容'}
                                </p>
                              </div>
                              <div className="flex items-center gap-3 mt-1.5 text-xs text-tavern-text-muted">
                                <span>{POSITION_LABELS[entry.position]}</span>
                                <span>顺序 {entry.order}</span>
                                <span>概率 {entry.probability}%</span>
                              </div>
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                              <div onClick={(e) => e.stopPropagation()}>
                                <Toggle
                                  checked={entry.enabled}
                                  onChange={(v) => {
                                    const entries = selected.entries.map((e) =>
                                      e.id === entry.id ? { ...e, enabled: v } : e
                                    )
                                    updateLorebook(selected.id, { entries })
                                  }}
                                />
                              </div>
                              <button
                                className="btn-ghost p-1.5"
                                onClick={() => handleEditEntry(entry)}
                                title="编辑"
                              >
                                <Pencil className="w-4 h-4" />
                              </button>
                              <button
                                className="btn-ghost p-1.5"
                                title="AI 翻译此条目"
                                disabled={!!translatingField || !entry.content}
                                onClick={() => handleAiTranslate(entry.content, `entry-${entry.id}`, (translated) => {
                                  const entries = selected.entries.map((e) =>
                                    e.id === entry.id ? { ...e, content: translated } : e
                                  )
                                  updateLorebook(selected.id, { entries })
                                })}
                              >
                                {translatingField?.key === `entry-${entry.id}` ? (
                                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                ) : (
                                  <Languages className="w-3.5 h-3.5" />
                                )}
                              </button>
                              <button
                                className="btn-ghost p-1.5 text-tavern-danger"
                                onClick={() => setDeleteEntryId(entry.id)}
                                title="删除"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* 条目编辑表单 */}
                {editingEntry && (
                  <div className="border-t border-tavern-border-soft bg-tavern-bg-soft p-4 space-y-3 shrink-0 max-h-[55%] overflow-y-auto">
                    <div className="flex items-center justify-between">
                      <h3 className="font-medium text-sm text-tavern-text">
                        {selected.entries.some((e) => e.id === editingEntry.id)
                          ? '编辑条目'
                          : '新建条目'}
                      </h3>
                      <div className="flex items-center gap-2">
                        <button className="btn-ghost" onClick={() => setEditingEntry(null)}>
                          取消
                        </button>
                        <button className="btn-primary" onClick={handleSaveEntry}>
                          保存条目
                        </button>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="col-span-2">
                        <label className="label">关键词（逗号分隔）</label>
                        <input
                          className="input"
                          placeholder="例如：魔法,世界,设定"
                          value={editingEntry.keywords.join(',')}
                          onChange={(e) =>
                            setEditingEntry({
                              ...editingEntry,
                              keywords: e.target.value
                                .split(',')
                                .map((s) => s.trim())
                                .filter(Boolean),
                            })
                          }
                        />
                      </div>
                      <div className="col-span-2">
                        <label className="label">内容</label>
                        <div className="flex gap-1.5 items-start">
                          <textarea
                            className="textarea h-24 flex-1"
                            placeholder="当关键词被触发时插入的内容..."
                            value={editingEntry.content}
                            onChange={(e) =>
                              setEditingEntry({ ...editingEntry, content: e.target.value })
                            }
                          />
                          <button
                            className="btn-ghost p-1.5 shrink-0"
                            title="AI 翻译内容"
                            disabled={!!translatingField || !editingEntry.content}
                            onClick={() => handleAiTranslate(editingEntry.content, `edit-${editingEntry.id}`, (translated) => {
                              setEditingEntry({ ...editingEntry, content: translated })
                            })}
                          >
                            {translatingField?.key === `edit-${editingEntry.id}` ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <Languages className="w-3.5 h-3.5" />
                            )}
                          </button>
                        </div>
                        {/* 翻译流式预览 */}
                        {translatingField?.key === `edit-${editingEntry.id}` && translateResult !== null && (
                          <div className="mt-1.5 p-2 rounded bg-tavern-bg-hover border border-tavern-border-soft text-xs text-tavern-text-soft max-h-24 overflow-y-auto">
                            {translateResult || '...'}
                          </div>
                        )}
                      </div>
                      <div>
                        <label className="label">插入位置</label>
                        <select
                          className="select"
                          value={editingEntry.position}
                          onChange={(e) =>
                            setEditingEntry({
                              ...editingEntry,
                              position: e.target.value as LoreEntry['position'],
                            })
                          }
                        >
                          <option value="before_char">{POSITION_LABELS.before_char}</option>
                          <option value="after_char">{POSITION_LABELS.after_char}</option>
                          <option value="at_end">{POSITION_LABELS.at_end}</option>
                        </select>
                      </div>
                      <div>
                        <label className="label">顺序</label>
                        <input
                          type="number"
                          className="input"
                          value={editingEntry.order}
                          onChange={(e) =>
                            setEditingEntry({
                              ...editingEntry,
                              order: Number(e.target.value) || 0,
                            })
                          }
                        />
                      </div>
                      <div className="col-span-2">
                        <label className="label">触发概率：{editingEntry.probability}%</label>
                        <input
                          type="range"
                          min={0}
                          max={100}
                          value={editingEntry.probability}
                          onChange={(e) =>
                            setEditingEntry({
                              ...editingEntry,
                              probability: Number(e.target.value),
                            })
                          }
                          className="w-full accent-tavern-accent"
                        />
                      </div>
                      <div className="col-span-2 flex items-center gap-2">
                        <span className="text-sm text-tavern-text-soft">启用此条目</span>
                        <Toggle
                          checked={editingEntry.enabled}
                          onChange={(v) => setEditingEntry({ ...editingEntry, enabled: v })}
                        />
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* 删除世界书确认 */}
      <ConfirmDialog
        open={!!deleteId}
        onClose={() => setDeleteId(null)}
        onConfirm={handleDelete}
        title="删除世界书"
        message="确定要删除这本世界书吗？所有条目都将被删除。此操作不可撤销。"
        confirmText="删除"
        danger
      />

      {/* 删除条目确认 */}
      <ConfirmDialog
        open={!!deleteEntryId}
        onClose={() => setDeleteEntryId(null)}
        onConfirm={handleDeleteEntry}
        title="删除条目"
        message="确定要删除这个条目吗？此操作不可撤销。"
        confirmText="删除"
        danger
      />
    </div>
  )
}
