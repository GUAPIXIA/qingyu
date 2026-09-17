import { useCallback, useEffect, useRef, useState } from 'react'
import { nanoid } from 'nanoid'
import { EmptyState } from '../components/common/EmptyState'
import { ConfirmDialog } from '../components/common/ConfirmDialog'
import { Modal } from '../components/common/Modal'
import { cn } from '../lib/utils'
import { logError } from '../lib/logger'
import {
  BookOpen,
  BookMarked,
  Plus,
  Upload,
  Download,
  Trash2,
  Pencil,
  Languages,
  Loader2,
  ChevronDown,
  ChevronUp,
  Brain,
  CircleCheck,
  CircleAlert,
  Search,
  Sparkles,
  Wand2,
  HeartPulse,
} from 'lucide-react'
import { useSettingsStore } from '../store/useSettingsStore'
import { resolveRendererGenerationTaskBudget } from '../store/generationTaskBudget'
import type { Lorebook, LoreEntry } from '../../shared/types'
import { stripAllThinking } from '../../shared/thoughtMarkup'
import type {
  LorebookFormatChoicePending,
  LorebookImportResult,
  LorebookImportOutcome,
  LorebookKeywordLocalizationSuggestion,
} from '../../shared/ipc-api'
import type { LorebookHealthReport } from '../../shared/lorebook/health'
import { LorebookEntryEditor } from './lorebook/LorebookEntryEditor'
import { LorebookKeywordLocalizationModal } from './lorebook/LorebookKeywordLocalizationModal'
import { LorebookImportReportModal } from './lorebook/LorebookImportReportModal'
import { LorebookFormatChoiceModal } from './lorebook/LorebookFormatChoiceModal'
import { LorebookMappingWizardModal } from './lorebook/LorebookMappingWizardModal'
import { LorebookHealthReportModal } from './lorebook/LorebookHealthReportModal'
import { LorebookBatchSemanticModal } from './lorebook/LorebookBatchSemanticModal'
import { appendLocalizedKeywords } from '../utils/lorebookLocalization'
import { Toggle } from './lorebook/lorebookComponents'
import { POSITION_LABELS, MATCH_MODE_LABELS, PRIORITY_LABELS } from './lorebook/lorebookConstants'

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
  const [bookSearch, setBookSearch] = useState('')
  const [entrySearch, setEntrySearch] = useState('')
  const [keywordLocalizationOpen, setKeywordLocalizationOpen] = useState(false)
  const [keywordEnrichOpen, setKeywordEnrichOpen] = useState(false)
  const [importResult, setImportResult] = useState<LorebookImportResult | null>(null)
  /** 方案 §6.1：格式歧义时由用户确认实际格式 */
  const [formatChoice, setFormatChoice] = useState<LorebookFormatChoicePending | null>(null)
  const [mappingWizardOpen, setMappingWizardOpen] = useState(false)
  const [healthReport, setHealthReport] = useState<LorebookHealthReport | 'loading' | null>(null)
  const [operationError, setOperationError] = useState<{ title: string; message: string } | null>(null)
  const [batchSemanticOpen, setBatchSemanticOpen] = useState(false)
  const [batchSemanticBusy, setBatchSemanticBusy] = useState(false)
  const [importHelpOpen, setImportHelpOpen] = useState(false)

  /** 乐观冲突检测（方案 §10.3）：每本书记录最近一次保存返回的磁盘 revision 作为编辑基准 */
  const revisionRef = useRef(new Map<string, number>())
  /** 每本书串行化保存，避免在途保存返回前用旧 revision 再次保存造成误报冲突 */
  const saveQueueRef = useRef(new Map<string, Promise<unknown>>())

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
  const activeProfile = getActiveProfile()

  /** 刷新向量索引状态 */
  const refreshIndexStatus = useCallback(async (ids: string[]) => {
    if (ids.length === 0) return
    try {
      const st = settings.semanticTrigger
      const status = await window.api.embedding.indexStatus(ids, st ? { provider: st.provider, baseUrl: st.baseUrl, model: st.model, apiKey: st.apiKey ?? '' } : undefined)
      setIndexStatus(status)
    } catch { /* 忽略 */ }
  }, [settings.semanticTrigger])

  useEffect(() => {
    window.api.lorebook.list().then((list) => {
      setLorebooks(list)
      list.forEach((book) => {
        if (book.runtime?.revision !== undefined) revisionRef.current.set(book.id, book.runtime.revision)
      })
      if (list.length > 0) setSelectedId(list[0].id)
    })
  }, [])

  useEffect(() => {
    void refreshIndexStatus(lorebooks.map((l) => l.id))
  }, [lorebooks, refreshIndexStatus])

  /** 为当前世界书生成/重建向量索引 */
  const handleIndexLorebook = async () => {
    if (!selected || indexingId) return
    const st = settings.semanticTrigger
    if (!st) {
      setIndexError('请先在「模型 → 语义检索」中配置向量来源')
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

  /** 单本世界书的保存串行化执行：携带最新编辑基准 revision，冲突时重载磁盘版本（方案 §10.3） */
  const runQueuedSave = async (payload: Lorebook): Promise<void> => {
    const expected = revisionRef.current.get(payload.id)
    try {
      const { revision } = await window.api.lorebook.save(payload, expected)
      revisionRef.current.set(payload.id, revision)
      setLorebooks((prev) => prev.map((l) => (
        l.id === payload.id ? { ...l, runtime: { ...(l.runtime ?? { schemaVersion: 2 }), revision } } : l
      )))
    } catch (error) {
      if (error instanceof Error && error.message.includes('LOREBOOK_SAVE_CONFLICT')) {
        const list = await window.api.lorebook.list()
        revisionRef.current.clear()
        list.forEach((book) => {
          if (book.runtime?.revision !== undefined) revisionRef.current.set(book.id, book.runtime.revision)
        })
        setLorebooks(list)
        setOperationError({
          title: '世界书保存冲突',
          message: '该世界书已被其他窗口修改，已重新加载磁盘上的最新版本；请在最新版本上继续编辑。',
        })
        return
      }
      throw error
    }
  }

  const enqueueSave = (payload: Lorebook): Promise<void> => {
    const prev = saveQueueRef.current.get(payload.id) ?? Promise.resolve()
    const task = prev.then(
      () => runQueuedSave(payload),
      () => runQueuedSave(payload),
    )
    const tail = task.then(() => {}, () => {})
    saveQueueRef.current.set(payload.id, tail)
    tail.then(() => {
      if (saveQueueRef.current.get(payload.id) === tail) saveQueueRef.current.delete(payload.id)
    })
    return task
  }

  const updateLorebook = async (id: string, patch: Partial<Lorebook>): Promise<boolean> => {
    const current = lorebooks.find((l) => l.id === id)
    if (!current) return false
    const updated: Lorebook = { ...current, ...patch }
    setLorebooks((prev) => prev.map((l) => (l.id === id ? updated : l)))
    try {
      await enqueueSave(updated)
      return true
    } catch (error) {
      setOperationError({
        title: '世界书保存失败',
        message: error instanceof Error ? error.message : String(error),
      })
      return false
    }
  }

  const handleNew = async () => {
    const lb = createLorebook()
    setLorebooks((prev) => [...prev, lb])
    setSelectedId(lb.id)
    setEditingEntry(null)
    setKeywordLocalizationOpen(false)
    try {
      await enqueueSave(lb)
    } catch (error) {
      setOperationError({
        title: '世界书保存失败',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const handleImport = async (options?: { pendingId?: string; adapterId?: string }) => {
    setOperationError(null)
    try {
      const outcome: LorebookImportOutcome | null = await window.api.lorebook.importJsonDetailed(options)
      if (!outcome) return
      if ('needsFormatChoice' in outcome) {
        // 方案 §6.1：格式歧义，弹窗让用户选择后再导入
        setFormatChoice(outcome)
        return
      }
      setFormatChoice(null)
      setLorebooks((prev) => [...prev, outcome.lorebook])
      if (outcome.lorebook.runtime?.revision !== undefined) {
        revisionRef.current.set(outcome.lorebook.id, outcome.lorebook.runtime.revision)
      }
      setSelectedId(outcome.lorebook.id)
      setEditingEntry(null)
      setKeywordLocalizationOpen(false)
      setImportResult(outcome)
    } catch (error) {
      setFormatChoice(null)
      setOperationError({
        title: '世界书导入失败',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const handleHealthCheck = async () => {
    setHealthReport('loading')
    try {
      setHealthReport(await window.api.lorebook.healthCheck())
    } catch (error) {
      setHealthReport(null)
      setOperationError({
        title: '健康检查失败',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const handleDelete = async () => {
    if (!deleteId) return
    await window.api.lorebook.delete(deleteId)
    revisionRef.current.delete(deleteId)
    setLorebooks((prev) => prev.filter((l) => l.id !== deleteId))
    if (selectedId === deleteId) setSelectedId(null)
    setDeleteId(null)
  }

  const handleExport = async () => {
    if (!selected) return
    try {
      await window.api.lorebook.exportJson(selected.id)
    } catch (error) {
      setOperationError({
        title: '世界书导出失败',
        message: error instanceof Error ? error.message : String(error),
      })
    }
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

  const batchSemanticEntries = selected?.entries.filter((entry) => (
    entry.enabled && entry.matchMode === 'keyword' && !!entry.content?.trim()
  )) ?? []

  const handleBatchEnableSemantic = async () => {
    if (!selected || batchSemanticBusy || batchSemanticEntries.length === 0) return
    setBatchSemanticBusy(true)
    setIndexError(null)
    const affectedIds = new Set(batchSemanticEntries.map((entry) => entry.id))
    const entries = selected.entries.map((entry) => (
      affectedIds.has(entry.id) ? { ...entry, matchMode: 'both' as const } : entry
    ))
    try {
      const saved = await updateLorebook(selected.id, { entries })
      setBatchSemanticOpen(false)
      if (saved) await handleIndexLorebook()
    } finally {
      setBatchSemanticBusy(false)
    }
  }

  const handleApplyLocalizedKeywords = async (
    suggestions: LorebookKeywordLocalizationSuggestion[],
  ) => {
    if (!selected) return
    await updateLorebook(selected.id, {
      entries: appendLocalizedKeywords(selected, suggestions),
    })
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
      setTranslateResult(stripAllThinking(result))
    })
    const unbindDone = window.api.ai.onComplete((payload) => {
      if (payload.requestId !== requestId) return
      cleanup()
      setTranslatingField(null)
      setTranslateResult(null)
      if (result.trim()) {
        // 剥离思考/推理标记，避免 AI 将思考过程混入翻译结果
        const cleanResult = stripAllThinking(result)
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
    const model = settings.activeModel || profile.model
    const translationPlan = await resolveRendererGenerationTaskBudget({
      profile,
      model,
      task: 'translation',
      inputChars: text.length,
      usageTaskType: 'translation',
    })
    window.api.ai.chat({
      requestId,
      messages: [
        { role: 'system', content: `你是一个翻译助手。请将以下文本翻译成${targetLang}。只输出翻译结果，不要添加任何解释或额外内容。保留原文中的标点符号风格。` },
        { role: 'user', content: text },
      ],
      provider: profile.provider,
      apiKey: profile.apiKey,
      baseUrl: profile.baseUrl,
      model,
      temperature: 0.3,
      topP: 0.9,
      maxTokens: translationPlan.requestMaxTokens,
      frequencyPenalty: 0,
      presencePenalty: 0,
      stream: true,
      observability: { source: 'aux', taskType: 'translation' },
      adaptiveOutputBudget: translationPlan.adaptiveOutputBudget,
      reasoningGate: translationPlan.reasoningGate,
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
          <div className="relative">
            <div className="inline-flex items-stretch" role="group" aria-label="导入、映射向导与说明">
              <button onClick={() => handleImport()} className="btn-primary rounded-r-none">
                <Upload className="w-4 h-4" />
                导入
              </button>
              <button onClick={() => setMappingWizardOpen(true)} className="btn-secondary rounded-none border-l-0">
                <Wand2 className="w-4 h-4" />
                映射向导
              </button>
              <button
                type="button"
                aria-label="查看导入方式说明"
                aria-expanded={importHelpOpen}
                aria-controls="lorebook-import-help"
                title={importHelpOpen ? '隐藏导入方式说明' : '查看导入方式说明'}
                onClick={() => setImportHelpOpen((open) => !open)}
                className={cn(
                  'flex w-9 items-center justify-center rounded-r-lg border border-l-0 transition-colors',
                  importHelpOpen
                    ? 'border-tavern-accent bg-tavern-accent-soft text-tavern-accent'
                    : 'border-tavern-border bg-tavern-bg-card text-tavern-text-muted hover:bg-tavern-bg-hover hover:text-tavern-accent',
                )}
              >
                <CircleAlert className="h-4 w-4" />
              </button>
            </div>
            {importHelpOpen && (
              <div
                id="lorebook-import-help"
                className="absolute right-0 top-full z-40 mt-2 w-80 rounded-xl border border-tavern-border bg-tavern-bg-card p-3 shadow-xl"
              >
                <div className="space-y-3 text-xs leading-5">
                  <div>
                    <p className="font-medium text-tavern-text">导入</p>
                    <p className="text-tavern-text-muted">自动识别轻语、SillyTavern、CCv2/CCv3 等已支持的标准世界书格式。</p>
                  </div>
                  <div className="border-t border-tavern-border-soft pt-3">
                    <p className="font-medium text-tavern-text">映射向导</p>
                    <p className="text-tavern-text-muted">用于无法自动识别的自定义 JSON，手动指定名称、关键词、正文等字段的对应关系。</p>
                  </div>
                </div>
              </div>
            )}
          </div>
          <button onClick={handleNew} className="btn-secondary">
            <Plus className="w-4 h-4" />
            新建
          </button>
          <button onClick={() => void handleHealthCheck()} className="btn-secondary">
            <HeartPulse className="w-4 h-4" />
            健康检查
          </button>
          <button onClick={handleExport} className="btn-secondary" disabled={!selected}>
            <Download className="w-4 h-4" />
            导出
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
              <button className="btn-secondary" onClick={() => handleImport()}>
                <Upload className="w-4 h-4" />
                导入世界书
              </button>
            </div>
          }
        />
      ) : (
        <div className="flex-1 flex overflow-hidden">
          {/* 左侧列表 - S3：书级搜索 */}
          <aside className="w-72 border-r border-tavern-border-soft overflow-y-auto p-3 space-y-2 shrink-0 flex flex-col">
            <div className="flex items-center gap-2 bg-tavern-bg rounded-lg px-2 py-1.5 border border-tavern-border-soft shrink-0">
              <Search className="w-3.5 h-3.5 text-tavern-text-muted" aria-hidden />
              <input value={bookSearch} onChange={e => setBookSearch(e.target.value)} placeholder="搜索世界书..." className="flex-1 bg-transparent outline-none text-sm placeholder:text-tavern-text-muted" aria-label="搜索世界书" />
            </div>
            <div className="space-y-2 flex-1 overflow-y-auto">
            {(bookSearch.trim() ? lorebooks.filter(lb => lb.name.toLowerCase().includes(bookSearch.toLowerCase()) || lb.description.toLowerCase().includes(bookSearch.toLowerCase())) : lorebooks).map((lb) => (
              <div
                key={lb.id}
                onClick={() => {
                  setSelectedId(lb.id)
                  setEditingEntry(null)
                  setKeywordLocalizationOpen(false)
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
            </div>
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
                          min={0}
                          className="input"
                          value={selected.scanDepth}
                          onChange={(e) =>
                            updateLorebook(selected.id, {
                              scanDepth: Number.isFinite(e.currentTarget.valueAsNumber)
                                ? Math.max(0, Math.floor(e.currentTarget.valueAsNumber))
                                : 0,
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
                  <div className="flex flex-wrap items-center gap-3 pt-1">
                    <button
                      className="btn-secondary text-xs"
                      disabled={selected.entries.length === 0}
                      onClick={() => setKeywordLocalizationOpen(true)}
                      title="使用当前聊天模型为英文条目生成中文触发词；无需语义索引"
                    >
                      <Sparkles className="w-3.5 h-3.5" />
                      生成中文触发词
                    </button>
                    <button
                      className="btn-secondary text-xs"
                      disabled={selected.entries.length === 0}
                      onClick={() => setKeywordEnrichOpen(true)}
                      title="使用当前聊天模型从条目正文提取实体、别名与跨语言关键词（阶段4 enrichment 管线）；无需语义索引"
                    >
                      <Sparkles className="w-3.5 h-3.5" />
                      AI 扩词
                    </button>
                    <div
                      className="inline-flex items-center gap-1.5 rounded-xl border border-tavern-accent/25 bg-tavern-accent-soft/40 p-1.5"
                      role="group"
                      aria-label="语义索引操作"
                    >
                      <button
                        className="btn-secondary text-xs"
                        disabled={batchSemanticEntries.length === 0 || indexingId !== null || batchSemanticBusy}
                        onClick={() => setBatchSemanticOpen(true)}
                        title="将已启用的仅关键词条目批量改为关键词 + 语义"
                      >
                        <Brain className="w-3.5 h-3.5" />
                        批量启用语义
                        {batchSemanticEntries.length > 0 && (
                          <span className="rounded-full bg-tavern-accent-soft px-1.5 text-[10px] text-tavern-accent">{batchSemanticEntries.length}</span>
                        )}
                      </button>
                      <button
                        className="btn-secondary text-xs"
                        disabled={indexingId !== null}
                        onClick={handleIndexLorebook}
                        title="为启用且匹配模式包含「语义」的条目生成向量索引（需在模型 → 语义检索中配置向量来源）"
                      >
                        {indexingId === selected.id ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Brain className="w-3.5 h-3.5" />
                        )}
                        {indexingId === selected.id ? '索引中...' : '生成语义索引'}
                      </button>
                    </div>
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

                {/* 条目列表 - S3：条目搜索与过滤 */}
                <div className="flex-1 overflow-y-auto p-4">
                  <div className="flex items-center justify-between mb-3 gap-2">
                    <h3 className="font-medium text-sm text-tavern-text shrink-0">
                      条目（{selected.entries.length}）
                    </h3>
                    <div className="flex items-center gap-2 flex-1 justify-end">
                      <div className="flex items-center gap-1.5 bg-tavern-bg rounded-lg px-2 py-1 border border-tavern-border-soft w-48">
                        <Search className="w-3.5 h-3.5 text-tavern-text-muted shrink-0" aria-hidden />
                        <input value={entrySearch} onChange={e => setEntrySearch(e.target.value)} placeholder="搜索条目..." className="flex-1 bg-transparent outline-none text-xs placeholder:text-tavern-text-muted" aria-label="搜索条目" />
                      </div>
                      <button className="btn-secondary shrink-0" onClick={handleNewEntry}>
                        <Plus className="w-4 h-4" />
                        新建条目
                      </button>
                    </div>
                  </div>
                  {(() => {
                    const q = entrySearch.trim().toLowerCase()
                    const filtered = q ? selected.entries.filter(e => e.keywords.join(' ').toLowerCase().includes(q) || e.content.toLowerCase().includes(q)) : selected.entries
                    if (filtered.length === 0 && selected.entries.length > 0) {
                      return <div className="text-center py-8 text-sm text-tavern-text-muted">无匹配条目</div>
                    }
                    if (selected.entries.length === 0) {
                      return <div className="text-center py-10 text-sm text-tavern-text-muted">暂无条目，点击「新建条目」开始添加</div>
                    }
                    return (
                    <div className="space-y-2">
                      {filtered.map((entry) => (
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
                                <span className={cn(
                                  'px-1.5 py-0.5 rounded',
                                  entry.priority === 'always'
                                    ? 'bg-tavern-accent-soft text-tavern-accent'
                                    : entry.priority === 'detail'
                                      ? 'bg-tavern-bg-hover/50 text-tavern-text-muted/70'
                                      : 'bg-tavern-bg-hover text-tavern-text-soft',
                                )}>
                                  {PRIORITY_LABELS[entry.priority ?? 'conditional']}
                                </span>
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
                  )
                  })()}
                </div>

                {/* 条目编辑弹窗（交互与角色卡编辑器一致） */}
                {editingEntry && (
                  <LorebookEntryEditor
                    lorebook={selected}
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

      <LorebookBatchSemanticModal
        open={batchSemanticOpen}
        affectedCount={batchSemanticEntries.length}
        busy={batchSemanticBusy}
        onClose={() => setBatchSemanticOpen(false)}
        onConfirm={handleBatchEnableSemantic}
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

      {keywordLocalizationOpen && selected && (
        <LorebookKeywordLocalizationModal
          lorebook={selected}
          profile={activeProfile}
          model={settings.activeModel || activeProfile?.model || ''}
          onApply={handleApplyLocalizedKeywords}
          onClose={() => setKeywordLocalizationOpen(false)}
        />
      )}

      {keywordEnrichOpen && selected && (
        <LorebookKeywordLocalizationModal
          lorebook={selected}
          profile={activeProfile}
          model={settings.activeModel || activeProfile?.model || ''}
          mode="enrich"
          onApply={handleApplyLocalizedKeywords}
          onClose={() => setKeywordEnrichOpen(false)}
        />
      )}

      {formatChoice && (
        <LorebookFormatChoiceModal
          choice={formatChoice}
          onConfirm={(adapterId) => handleImport({ pendingId: formatChoice.pendingId, adapterId })}
          onCancel={() => setFormatChoice(null)}
        />
      )}

      {importResult && (
        <LorebookImportReportModal
          result={importResult}
          onClose={() => setImportResult(null)}
        />
      )}

      {healthReport && (
        <LorebookHealthReportModal report={healthReport} onClose={() => setHealthReport(null)} />
      )}

      {mappingWizardOpen && (
        <LorebookMappingWizardModal
          onImported={(imported) => {
            setMappingWizardOpen(false)
            setLorebooks((prev) => [...prev, imported.lorebook])
            if (imported.lorebook.runtime?.revision !== undefined) {
              revisionRef.current.set(imported.lorebook.id, imported.lorebook.runtime.revision)
            }
            setSelectedId(imported.lorebook.id)
            setEditingEntry(null)
            setImportResult(imported)
          }}
          onClose={() => setMappingWizardOpen(false)}
        />
      )}

      <Modal
        open={!!operationError}
        onClose={() => setOperationError(null)}
        title={operationError?.title}
        width="sm"
        footer={<button className="btn-primary px-4 py-2" onClick={() => setOperationError(null)}>知道了</button>}
      >
        <p className="text-sm leading-relaxed text-tavern-text-soft">{operationError?.message}</p>
      </Modal>
    </div>
  )
}
