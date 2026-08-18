import { useEffect, useRef, useState } from 'react'
import { nanoid } from 'nanoid'
import { EmptyState } from '../components/common/EmptyState'
import { ConfirmDialog } from '../components/common/ConfirmDialog'
import { cn } from '../lib/utils'
import { logError } from '../lib/logger'
import { safeSave } from '../lib/safeOps'
import {
  BookOpen,
  BookMarked,
  Plus,
  Upload,
  Trash2,
  Pencil,
  Languages,
  Loader2,
  ChevronDown,
  ChevronUp,
  Brain,
  CircleCheck,
  CircleAlert,
} from 'lucide-react'
import { useSettingsStore } from '../store/useSettingsStore'
import { translationMaxTokens } from '../store/chatConstants'
import type { Lorebook, LoreEntry } from '../../shared/types'
import { LorebookEntryEditor } from './lorebook/LorebookEntryEditor'
import { Toggle } from './lorebook/lorebookComponents'
import { POSITION_LABELS, MATCH_MODE_LABELS } from './lorebook/lorebookConstants'

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
    matchMode: 'both',
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
  /** AI 翻译错误提示（空结果等） */
  const [translateError, setTranslateError] = useState<string | null>(null)
  /** 语义触发：向量索引状态（lorebookId -> 已索引条目数等） */
  const [indexStatus, setIndexStatus] = useState<Record<string, { indexed: number; model: string; updatedAt: number; stale: number }>>({})
  const [indexingId, setIndexingId] = useState<string | null>(null)
  const [indexError, setIndexError] = useState<string | null>(null)

  const { getActiveProfile, settings } = useSettingsStore()

  /** H-09 修复：追踪活跃的 AI 请求 ID，组件卸载时取消并清理监听器 */
  const activeRequestIdsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    const ref = activeRequestIdsRef
    return () => {
      const ids = Array.from(ref.current)
      for (const id of ids) {
        window.api.ai.cancelChat(id).catch((e) => logError('LorebookPage:cancelChat', e))
      }
      ref.current.clear()
    }
  }, [])

  const selected = lorebooks.find((l) => l.id === selectedId) ?? null

  useEffect(() => {
    window.api.lorebook.list().then((list) => {
      setLorebooks(list)
      if (list.length > 0) setSelectedId(list[0].id)
      refreshIndexStatus(list.map((l) => l.id))
    })
  }, [])

  /** 刷新向量索引状态 */
  const refreshIndexStatus = async (ids: string[]) => {
    if (ids.length === 0) return
    try {
      const status = await window.api.embedding.indexStatus(ids)
      setIndexStatus(status)
    } catch { /* 忽略 */ }
  }

  /** 为当前世界书生成/重建向量索引 */
  const handleIndexLorebook = async () => {
    if (!selected || indexingId) return
    const st = settings.semanticTrigger
    if (!st) {
      setIndexError('请先在「设置 → 语义触发」中配置嵌入服务')
      return
    }
    setIndexingId(selected.id)
    setIndexError(null)
    try {
      const result = await window.api.embedding.indexLorebook(selected.id, {
        provider: st.provider,
        baseUrl: st.baseUrl,
        model: st.model,
        apiKey: st.apiKey ?? '',
      })
      if (!result.ok) {
        setIndexError(result.error || '索引失败')
      }
      await refreshIndexStatus([selected.id])
    } catch (e) {
      setIndexError((e as Error).message)
    } finally {
      setIndexingId(null)
    }
  }

  const updateLorebook = async (id: string, patch: Partial<Lorebook>) => {
    const current = lorebooks.find((l) => l.id === id)
    if (!current) return
    const updated: Lorebook = { ...current, ...patch }
    setLorebooks((prev) => prev.map((l) => (l.id === id ? updated : l)))
    await safeSave(() => window.api.lorebook.save(updated), '世界书保存')
  }

  const handleNew = async () => {
    const lb = createLorebook()
    setLorebooks((prev) => [...prev, lb])
    setSelectedId(lb.id)
    setEditingEntry(null)
    await safeSave(() => window.api.lorebook.save(lb), '世界书保存')
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
    setTranslateError(null)

    const requestId = `lorebook-translate-${Date.now()}`
    activeRequestIdsRef.current.add(requestId)
    let result = ''

    const cleanup = () => {
      activeRequestIdsRef.current.delete(requestId)
      unbindChunk(); unbindDone(); unbindError()
    }

    const unbindChunk = window.api.ai.onChunk((data) => {
      if (data.requestId !== requestId) return
      result += data.text
      setTranslateResult(result.replace(/<thought>[\s\S]*?<\/thought>/gi, '').replace(/<thinking>[\s\S]*?<\/thinking>/gi, '').trim())
    })
    const unbindDone = window.api.ai.onDone((doneId) => {
      if (doneId !== requestId) return
      cleanup()
      setTranslatingField(null)
      setTranslateResult(null)
      if (result.trim()) {
        // 剥离 <thought> / <thinking> 标签，避免 AI 将思考过程混入翻译结果
        const cleanResult = result
          .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
          .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
          .trim()
        if (cleanResult) {
          onApply(cleanResult)
        } else {
          setTranslateError('翻译结果为空，请重试或更换模型')
        }
      } else {
        setTranslateError('翻译结果为空，请重试或更换模型')
      }
    })
    const unbindError = window.api.ai.onError((data) => {
      if (data.requestId !== requestId) return
      cleanup()
      setTranslatingField(null)
      setTranslateResult(null)
    })

    const targetLang = settings.translationTargetLang || '中文'
    window.api.ai.chat({
      requestId,
      messages: [
        { role: 'system', content: `你是一个翻译助手。请将以下文本翻译成${targetLang}。只输出翻译结果，不要添加任何解释或额外内容。保留原文中的标点符号风格。` },
        { role: 'user', content: text },
      ],
      provider: profile.provider,
      apiKey: profile.apiKey,
      baseUrl: profile.baseUrl,
      model: settings.activeModel || profile.model,
      temperature: 0.3,
      topP: 0.9,
      maxTokens: translationMaxTokens(text),
      frequencyPenalty: 0,
      presencePenalty: 0,
      stream: true,
    }).catch(() => {
      cleanup()
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

                  {/* 语义触发：向量索引 */}
                  <div className="flex items-center gap-3 pt-1">
                    <button
                      className="btn-secondary text-xs"
                      disabled={indexingId !== null}
                      onClick={handleIndexLorebook}
                      title="为启用且匹配模式包含「语义」的条目生成向量索引（语义触发需在设置中启用）"
                    >
                      {indexingId === selected.id ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Brain className="w-3.5 h-3.5" />
                      )}
                      {indexingId === selected.id ? '索引中...' : '生成语义索引'}
                    </button>
                    {indexStatus[selected.id] && indexStatus[selected.id].indexed > 0 ? (
                      <span className="text-xs text-tavern-text-muted flex items-center gap-1">
                        <CircleCheck className="w-3.5 h-3.5 text-tavern-accent" />
                        已索引 {indexStatus[selected.id].indexed} 个条目
                        <span className="text-tavern-text-muted/60">（{indexStatus[selected.id].model}）</span>
                        {indexStatus[selected.id].stale > 0 && (
                          <span className="text-xs text-tavern-warning flex items-center gap-0.5">
                            <CircleAlert className="w-3 h-3" />
                            {indexStatus[selected.id].stale} 条已过期（内容修改后需重新索引）
                          </span>
                        )}
                      </span>
                    ) : (
                      <span className="text-xs text-tavern-text-muted flex items-center gap-1">
                        <CircleAlert className="w-3.5 h-3.5 text-tavern-text-muted" />
                        未索引（语义触发条目需要先生成索引）
                      </span>
                    )}
                    {indexError && (
                      <span className="text-xs text-tavern-danger">{indexError}</span>
                    )}
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
                                {/* 翻译内容展示 */}
                                {entry.translation && (
                                  <div className={cn(
                                    'mt-1.5 pl-2 border-l-2 border-tavern-accent',
                                    expandedEntries.has(entry.id) ? '' : 'line-clamp-2'
                                  )}>
                                    <span className="text-xs text-tavern-accent font-medium">翻译：</span>
                                    <p className="text-xs text-tavern-text-soft mt-0.5 whitespace-pre-wrap">
                                      {entry.translation}
                                    </p>
                                  </div>
                                )}
                                {/* 翻译流式预览（条目列表） */}
                                {translatingField?.key === `entry-${entry.id}` && translateResult !== null && (
                                  <div className="mt-1.5 p-2 rounded bg-tavern-bg-hover border border-tavern-border-soft text-xs text-tavern-text-soft max-h-24 overflow-y-auto">
                                    {translateResult || '...'}
                                  </div>
                                )}
                                {/* 翻译错误提示（条目列表） */}
                                {translateError && translatingField?.key !== `entry-${entry.id}` && !entry.translation && (
                                  <div className="mt-1.5 text-xs text-tavern-danger">{translateError}</div>
                                )}
                              </div>
                              <div className="flex items-center gap-3 mt-1.5 text-xs text-tavern-text-muted">
                                <span>{POSITION_LABELS[entry.position]}</span>
                                <span>顺序 {entry.order}</span>
                                <span>概率 {entry.probability}%</span>
                                <span className="px-1.5 py-0.5 rounded bg-tavern-bg-hover text-tavern-text-soft">
                                  {MATCH_MODE_LABELS[entry.matchMode ?? 'both']}
                                </span>
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
                                className={cn(
                                  'btn-ghost p-1.5',
                                  entry.translation && 'text-tavern-accent'
                                )}
                                title={entry.translation ? 'AI 翻译此条目（已有翻译）' : 'AI 翻译此条目'}
                                disabled={!!translatingField || !entry.content}
                                onClick={() => handleAiTranslate(entry.content, `entry-${entry.id}`, (translated) => {
                                  const entries = selected.entries.map((e) =>
                                    e.id === entry.id ? { ...e, translation: translated } : e
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

                {/* 条目编辑表单（P-8 拆至 LorebookEntryEditor） */}
                {editingEntry && (
                  <LorebookEntryEditor
                    editingEntry={editingEntry}
                    isNew={!selected.entries.some((e) => e.id === editingEntry.id)}
                    setEditingEntry={setEditingEntry}
                    translatingField={translatingField}
                    translateResult={translateResult}
                    translateError={translateError}
                    onTranslate={handleAiTranslate}
                    onSave={handleSaveEntry}
                    onCancel={() => setEditingEntry(null)}
                  />
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
