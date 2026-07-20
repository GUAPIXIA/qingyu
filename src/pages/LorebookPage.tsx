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
} from 'lucide-react'
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
                        <input
                          className="input"
                          value={selected.name}
                          onChange={(e) => updateLorebook(selected.id, { name: e.target.value })}
                        />
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
                    <input
                      className="input"
                      value={selected.description}
                      onChange={(e) =>
                        updateLorebook(selected.id, { description: e.target.value })
                      }
                    />
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
                              <p className="text-xs text-tavern-text-soft line-clamp-2">
                                {entry.content || '无内容'}
                              </p>
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
                        <textarea
                          className="textarea h-24"
                          placeholder="当关键词被触发时插入的内容..."
                          value={editingEntry.content}
                          onChange={(e) =>
                            setEditingEntry({ ...editingEntry, content: e.target.value })
                          }
                        />
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
