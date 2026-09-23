import { useState, useMemo, useEffect, useCallback, useDeferredValue, useRef } from "react"
import { useNavigate } from "react-router-dom"
import { useCharacterStore } from "../store/useCharacterStore"
import { useToastStore } from "../store/useToastStore"
import { CharacterCard } from "../components/character/CharacterCard"
import { CharacterEditor } from "../components/character/CharacterEditor"
import { CharacterDetail } from "../components/character/CharacterDetail"
import { EmptyState } from "../components/common/EmptyState"
import { ConfirmDialog } from "../components/common/ConfirmDialog"
import { Modal } from "../components/common/Modal"
import { cn } from "../lib/utils"
import { Users, Upload, FileUp, Search, AlertCircle, X, FileStack, CheckCircle, Info, Grid3X3, List, Loader2, FileWarning, ArrowDownUp, Sparkles, BookOpen, Wand2 } from "lucide-react"
import type { Character } from "../../shared/types"
// UEX-P1-17：导入同名冲突策略类型
import type { CharacterImportConflictPolicy } from "../../shared/ipc-api"

type CardSize = "sm" | "md" | "lg"
type SortKey = "updatedAt" | "createdAt" | "name"

function loadCardSize(): CardSize {
  try { return (localStorage.getItem("char-card-size") as CardSize) || "md" } catch { return "md" }
}

/** UEX-P1-17：读取同名冲突策略（默认另存副本；覆盖仅用户显式选择过才记住） */
function loadImportConflict(): CharacterImportConflictPolicy {
  try { return localStorage.getItem("char-import-conflict") === "overwrite" ? "overwrite" : "copy" } catch { return "copy" }
}

export function CharactersPage() {
  const navigate = useNavigate()
  const { characters, loaded, selectCharacter, deleteCharacter, importPng, importJson, importBatch, cancelImportBatch, saveCharacter, importError, importNotice, pendingAvatarId, importProgress, importingBatch, lorebookSuggestions, bindSuggestedLorebook } = useCharacterStore()
  const [editing, setEditing] = useState(false)
  const [editCharacter, setEditCharacter] = useState<Character | null>(null)
  const [search, setSearch] = useState("")
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid")
  const [cardSize, setCardSize] = useState<CardSize>(loadCardSize)
  const [sortKey, setSortKey] = useState<SortKey>("updatedAt")
  const [detailCharacter, setDetailCharacter] = useState<Character | null>(null)
  const [batchResult, setBatchResult] = useState<{ total: number; successCount: number; failCount: number; skippedCount: number; canceled: boolean; fails: { name: string; error: string }[]; skippedIdentical: number; copied: number; overwritten: number; notes: string[] } | null>(null)
  // UEX-P1-17：同名冲突策略（默认另存副本；「覆盖原卡」仅用户显式选择）
  const [importConflict, setImportConflict] = useState<CharacterImportConflictPolicy>(loadImportConflict)
  // UEX-P2-04：「取消导入」按钮的瞬时状态（点击后变「正在取消…」并禁用，批次结束后复位）
  const [canceling, setCanceling] = useState(false)

  const deferredSearch = useDeferredValue(search)

  const filtered = useMemo(() => {
    let result = characters
    if (deferredSearch) {
      const q = deferredSearch.toLowerCase()
      result = result.filter((c) => {
        const nameMatch = c.name.toLowerCase().includes(q)
        const safeTags: string[] = Array.isArray(c.tags) ? c.tags : typeof c.tags === 'string' ? (c.tags as unknown as string).split(/[,，、\n]+/) : []
        const tagMatch = safeTags.some((t) => t.toLowerCase().includes(q))
        const descMatch = c.description?.toLowerCase().includes(q)
        const personalityMatch = c.personality?.toLowerCase().includes(q)
        const scenarioMatch = c.scenario?.toLowerCase().includes(q)
        return nameMatch || tagMatch || descMatch || personalityMatch || scenarioMatch
      })
    }
    return [...result].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      if (sortKey === "name") return a.name.localeCompare(b.name)
      return (b[sortKey] as number) - (a[sortKey] as number)
    })
  }, [characters, deferredSearch, sortKey])

  const handleCardSizeChange = (size: CardSize) => {
    setCardSize(size)
    try { localStorage.setItem("char-card-size", size) } catch { /* ignore */ }
  }

  /** UEX-P1-17：切换同名冲突策略并记住选择（内容相同的卡不受影响，始终自动跳过） */
  const handleImportConflictChange = (policy: CharacterImportConflictPolicy) => {
    setImportConflict(policy)
    try { localStorage.setItem("char-import-conflict", policy) } catch { /* ignore */ }
  }

  const handleEdit = useCallback((char: Character) => {
    setEditCharacter({ ...char })
    setEditing(true)
  }, [])

  const [, setSavingChar] = useState(false)
  const handleSave = async (char: Character) => {
    setSavingChar(true)
    try {
      await saveCharacter(char)
      // UEX-P1-14：保存成功显式反馈，不再仅靠关闭编辑器隐式确认
      useToastStore.getState().push({ variant: 'success', title: `已保存「${char.name}」`, durationMs: 2500 })
      setEditing(false)
      setEditCharacter(null)
    } catch (e) {
      useToastStore.getState().push({ variant: 'error', title: '保存失败', description: e instanceof Error ? e.message : String(e) })
    } finally {
      setSavingChar(false)
    }
  }

  const handleStartChat = useCallback((char: Character) => {
    selectCharacter(char.id)
    navigate("/chat")
  }, [selectCharacter, navigate])

  const handleDetail = useCallback((char: Character) => {
    setDetailCharacter(char)
  }, [])

  const handleDeleteById = useCallback((id: string) => {
    setDeleteId(id)
  }, [])

  const handleDelete = async () => {
    if (deleteId) {
      await deleteCharacter(deleteId)
      setDeleteId(null)
    }
  }

  useEffect(() => {
    if (pendingAvatarId) {
      const char = characters.find(c => c.id === pendingAvatarId)
      if (char) {
        handleEdit(char)
        useCharacterStore.setState({ pendingAvatarId: null })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAvatarId, characters])

  useEffect(() => {
    return () => { if (batchTimerRef.current) clearTimeout(batchTimerRef.current) }
  }, [])

  // UEX-P2-04：批次状态变化（结束/新批次开始）即复位「正在取消…」按钮态
  useEffect(() => {
    setCanceling(false)
  }, [importingBatch])

  const batchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // UEX-P2-04：导入进行中禁用所有导入入口（防重入；主进程另有「已有导入任务进行中」兜底）
  const importBusy = importingBatch || importProgress !== null

  const handleCancelImport = useCallback(async () => {
    // 主进程侧幂等：重复点击/无进行中批次均安全
    setCanceling(true)
    try {
      await cancelImportBatch()
    } catch {
      // 取消请求失败时恢复按钮，允许重试
      setCanceling(false)
    }
  }, [cancelImportBatch])

  const handleBatchImport = async () => {
    // UEX-P1-17：冲突策略透传（默认另存副本；「覆盖原卡」仅在选项里显式选定）
    const result = await importBatch(importConflict)
    if (result) {
      const fails = (result.results || [])
        .filter(r => !r.success)
        .map(r => ({ name: r.name, error: r.error || "未知错误" }))
      // UEX-P1-17：查重/冲突明细（「已存在相同角色：X」/「已另存副本：…」/「已覆盖同名角色：…」）
      const notes = (result.results || [])
        .filter(r => r.outcome && r.outcome !== "imported" && r.note)
        .map(r => r.note as string)
      const canceled = !!result.canceled
      const skippedIdentical = result.skippedIdentical ?? 0
      setBatchResult({
        total: result.total || 0,
        successCount: result.successCount || 0,
        failCount: result.failCount || 0,
        skippedCount: result.skippedCount ?? Math.max(0, (result.total || 0) - (result.successCount || 0) - (result.failCount || 0) - skippedIdentical),
        canceled,
        fails,
        skippedIdentical,
        copied: result.copied ?? 0,
        overwritten: result.overwritten ?? 0,
        notes,
      })
      if (batchTimerRef.current) clearTimeout(batchTimerRef.current)
      // M4：有失败时结果条保持可见，便于阅读原因；UEX-P2-04：取消汇总同样不自动消失
      if (!canceled && fails.length === 0) {
        batchTimerRef.current = setTimeout(() => setBatchResult(null), 8000)
      }
    }
  }

  // 网格布局类：小/中/大卡片使用不同断点列数（VirtuosoGrid 已弃用——
  // 其对不等高卡片会滚动错位闪烁；直接渲染全部卡片，数量不大时更稳）
  const gridClass = viewMode === "list" ? "" : {
    sm: "grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-2",
    md: "grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3",
    lg: "grid-cols-1 sm:grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-3 gap-4",
  }[cardSize]

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {importError && (
        <div className="flex items-center gap-2 px-4 py-2 bg-tavern-danger/10 border-b border-tavern-danger/30 text-tavern-danger text-sm animate-fade-in">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span className="flex-1">{importError}</span>
          <button onClick={() => useCharacterStore.setState({ importError: null })} className="p-0.5 hover:opacity-70">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {importNotice && (
        <div className="flex items-center gap-2 px-4 py-2 bg-emerald-500/10 border-b border-emerald-500/30 text-emerald-600 text-sm animate-fade-in">
          <Sparkles className="w-4 h-4 shrink-0" />
          <span className="flex-1">{importNotice}</span>
          <button onClick={() => useCharacterStore.setState({ importNotice: null })} className="p-0.5 hover:opacity-70">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {batchResult && (
        <div className={cn(
          "flex items-center gap-2 px-4 py-2 border-b text-sm animate-fade-in",
          batchResult.canceled || batchResult.failCount > 0
            ? "bg-amber-500/10 border-amber-500/30 text-amber-600"
            : "bg-emerald-500/10 border-emerald-500/30 text-emerald-600"
        )}>
          {batchResult.canceled || batchResult.failCount > 0 ? (
            <Info className="w-4 h-4 shrink-0" />
          ) : (
            <CheckCircle className="w-4 h-4 shrink-0" />
          )}
          <span className="flex-1">
            {batchResult.canceled ? (
              // UEX-P2-04：取消汇总（对齐 M4 失败明细风格，不自动消失）
              <>批量导入已取消：成功 <strong>{batchResult.successCount}</strong> 个
                ，失败 <strong>{batchResult.failCount}</strong> 个
                ，未处理 <strong>{batchResult.skippedCount}</strong> 个
              </>
            ) : (
              <>批量导入完成：成功 <strong>{batchResult.successCount}</strong> 个
                {batchResult.failCount > 0 && (
                  <>，失败 <strong>{batchResult.failCount}</strong> 个</>
                )}
              </>
            )}
            {/* UEX-P1-17：查重/冲突结果明细——「跳过 N 个相同 / 副本 M 个 / 覆盖 K 个」 */}
            {(batchResult.skippedIdentical > 0 || batchResult.copied > 0 || batchResult.overwritten > 0) && (
              <span className="ml-1 text-tavern-text-muted">
                （{[
                  batchResult.skippedIdentical > 0 ? `跳过 ${batchResult.skippedIdentical} 个相同` : null,
                  batchResult.copied > 0 ? `副本 ${batchResult.copied} 个` : null,
                  batchResult.overwritten > 0 ? `覆盖 ${batchResult.overwritten} 个` : null,
                ].filter(Boolean).join(" / ")}）
              </span>
            )}
            {/* M4 失败明细 + UEX-P1-17 查重/冲突明细（「已存在相同角色：X」等） */}
            {(batchResult.fails.length > 0 || batchResult.notes.length > 0) && (
              <span className="ml-1 text-tavern-text-muted">
                （{[...batchResult.fails.map(f => `${f.name}：${f.error}`), ...batchResult.notes].join("；")}）
              </span>
            )}
          </span>
          <button onClick={() => setBatchResult(null)} className="p-0.5 hover:opacity-70">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {importProgress && (
        <div className="px-4 py-3 border-b border-tavern-border-soft bg-tavern-bg-soft animate-fade-in">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2 text-sm">
              {importProgress.status === "processing" ? (
                <Loader2 className="w-4 h-4 animate-spin text-tavern-accent" />
              ) : importProgress.status === "error" ? (
                <FileWarning className="w-4 h-4 text-tavern-danger" />
              ) : (
                <CheckCircle className="w-4 h-4 text-emerald-500" />
              )}
              <span className="text-tavern-text-soft">
                导入中 <strong>{importProgress.current}</strong> / {importProgress.total}
              </span>
            </div>
            <span className={cn(
              "text-xs truncate ml-4 max-w-[50%]",
              importProgress.status === "error" ? "text-tavern-danger" : "text-tavern-text-muted"
            )}>
              {importProgress.fileName}
            </span>
            {/* UEX-P2-04：批量导入进行中可取消；点击后变「正在取消…」并禁用（主进程侧幂等） */}
            {importingBatch && (
              <button
                onClick={handleCancelImport}
                disabled={canceling}
                className="btn-secondary text-xs px-2.5 py-1 ml-2 shrink-0 text-tavern-danger border-tavern-danger/40 hover:bg-tavern-danger/10 disabled:opacity-50 disabled:cursor-not-allowed"
                title="取消本次批量导入，已导入的角色会保留"
              >
                {canceling ? "正在取消…" : "取消导入"}
              </button>
            )}
          </div>
          <div className="w-full h-2 rounded-full bg-tavern-bg-hover overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-300 ease-out"
              style={{
                width: `${Math.round((importProgress.current / importProgress.total) * 100)}%`,
                background: importProgress.status === "error"
                  ? "linear-gradient(90deg, #ef4444, #f87171)"
                  : "linear-gradient(90deg, #d4a574, #e8b88a)",
              }}
            />
          </div>
          <div className="text-xs text-tavern-text-muted text-right mt-0.5">
            {Math.round((importProgress.current / importProgress.total) * 100)}%
          </div>
        </div>
      )}

      <header className="flex items-center justify-between px-4 h-14 border-b border-tavern-border-soft bg-tavern-bg-soft shrink-0">
        <h1 className="font-display text-lg font-bold">角色管理</h1>
        <div className="flex items-center gap-2">
          <button onClick={() => navigate('/character-create')} className="btn-primary" title="引导式制作角色卡（AI 辅助）">
            <Wand2 className="w-4 h-4" />
            制作角色卡
          </button>
          {/* UEX-P1-17：同名冲突策略（内容相同的卡始终自动跳过，不受此选项影响；覆盖仅显式选择） */}
          <select
            value={importConflict}
            onChange={(e) => handleImportConflictChange(e.target.value as CharacterImportConflictPolicy)}
            disabled={importBusy}
            className="text-xs bg-tavern-bg-hover border border-tavern-border rounded-md px-2 py-1.5 text-tavern-text-soft outline-none disabled:opacity-50 disabled:cursor-not-allowed"
            title="导入时遇到同名但内容不同的角色卡如何处理（内容相同的卡始终自动跳过）"
            aria-label="同名冲突时"
          >
            <option value="copy">同名冲突：另存副本</option>
            <option value="overwrite">同名冲突：覆盖原卡</option>
          </select>
          <button onClick={() => importPng(importConflict)} disabled={importBusy} className="btn-secondary disabled:opacity-50 disabled:cursor-not-allowed" title="导入 PNG 角色卡">
            <FileUp className="w-4 h-4" />
            PNG
          </button>
          <button onClick={() => importJson(importConflict)} disabled={importBusy} className="btn-secondary disabled:opacity-50 disabled:cursor-not-allowed" title="导入 JSON 角色卡">
            <Upload className="w-4 h-4" />
            JSON
          </button>
          {/* UEX-P2-04：导入进行中禁用导入入口（防重入） */}
          <button onClick={handleBatchImport} disabled={importBusy} className="btn-secondary disabled:opacity-50 disabled:cursor-not-allowed" title="批量导入角色卡">
            <FileStack className="w-4 h-4" />
            批量导入
          </button>
        </div>
      </header>

      {characters.length > 0 && (
        <div className="px-4 py-3 border-b border-tavern-border-soft flex items-center gap-3 flex-wrap">
          <div className="relative max-w-xs flex-1 min-w-[160px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-tavern-text-muted" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索角色或标签..."
              className="input pl-9"
            />
          </div>
          <div className="flex items-center gap-1.5">
            <ArrowDownUp className="w-3.5 h-3.5 text-tavern-text-muted" />
            <select
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as SortKey)}
              className="text-xs bg-tavern-bg-hover border border-tavern-border rounded-md px-2 py-1.5 text-tavern-text-soft outline-none"
            >
              <option value="updatedAt">最近更新</option>
              <option value="createdAt">创建时间</option>
              <option value="name">名称</option>
            </select>
          </div>
          <div className="flex-1" />
          <div className="flex items-center gap-0.5 bg-tavern-bg-hover rounded-lg p-0.5">
            {(["sm", "md", "lg"] as CardSize[]).map((size) => (
              <button
                key={size}
                onClick={() => handleCardSizeChange(size)}
                className={cn(
                  "px-2.5 py-1 rounded text-xs font-medium transition-colors",
                  cardSize === size ? "bg-tavern-bg-card shadow-sm text-tavern-accent" : "text-tavern-text-muted hover:text-tavern-text"
                )}
                title={size === "sm" ? "小卡片" : size === "md" ? "中卡片" : "大卡片"}
              >
                {size === "sm" ? "小" : size === "md" ? "中" : "大"}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-0.5 bg-tavern-bg-hover rounded-lg p-0.5">
            <button
              onClick={() => setViewMode("grid")}
              className={cn("p-1.5 rounded transition-colors", viewMode === "grid" ? "bg-tavern-bg-card shadow-sm text-tavern-accent" : "text-tavern-text-muted hover:text-tavern-text")}
              title="网格视图"
            >
              <Grid3X3 className="w-4 h-4" />
            </button>
            <button
              onClick={() => setViewMode("list")}
              className={cn("p-1.5 rounded transition-colors", viewMode === "list" ? "bg-tavern-bg-card shadow-sm text-tavern-accent" : "text-tavern-text-muted hover:text-tavern-text")}
              title="列表视图"
            >
              <List className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-4">
        {!loaded ? (
          // UEX-P2-05：数据未加载完成显示加载态，避免冷启动闪现「还没有角色」空态
          <div className="h-full flex flex-col items-center justify-center gap-3 text-tavern-text-muted" role="status">
            <Loader2 className="w-6 h-6 animate-spin text-tavern-accent" />
            <span className="text-sm">正在加载角色…</span>
          </div>
        ) : characters.length === 0 ? (
          <EmptyState
            className="h-full"
            icon={<Users className="w-8 h-8" />}
            title="还没有角色"
            description="制作你的第一张角色卡，或从 SillyTavern 导入角色卡"
            action={
              <div className="flex gap-2">
                <button className="btn-primary" onClick={() => navigate('/character-create')}>
                  <Wand2 className="w-4 h-4" />
                  制作角色卡
                </button>
                <button className="btn-secondary disabled:opacity-50 disabled:cursor-not-allowed" disabled={importBusy} onClick={() => importPng(importConflict)}>
                  <FileUp className="w-4 h-4" />
                  导入角色卡
                </button>
              </div>
            }
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            className="h-full"
            icon={<Search className="w-8 h-8" />}
            title="未找到匹配的角色"
            description={`没有包含 "${search}" 的角色`}
            action={
              // UEX-P2-06：搜索无结果提供一键清空
              <button className="btn-secondary" onClick={() => setSearch("")}>
                清空搜索
              </button>
            }
          />
        ) : viewMode === "list" ? (
          <div className="flex flex-col gap-3 max-w-3xl mx-auto pb-4">
            {filtered.map((char) => (
              <CharacterCard
                key={char.id}
                character={char}
                viewMode="list"
                cardSize={cardSize}
                onDetail={handleDetail}
                onEdit={handleEdit}
                onDelete={handleDeleteById}
                onChat={handleStartChat}
              />
            ))}
          </div>
        ) : (
          <div className={cn("grid pb-4", gridClass)}>
            {filtered.map((char) => (
              <CharacterCard
                key={char.id}
                character={char}
                cardSize={cardSize}
                onDetail={handleDetail}
                onEdit={handleEdit}
                onDelete={handleDeleteById}
                onChat={handleStartChat}
              />
            ))}
          </div>
        )}
      </div>

      {editing && editCharacter && (
        <CharacterEditor
          character={editCharacter}
          onSave={handleSave}
          onClose={() => { setEditing(false); setEditCharacter(null) }}
        />
      )}

      {detailCharacter && (
        <CharacterDetail
          character={detailCharacter}
          onClose={() => setDetailCharacter(null)}
          onEdit={() => {
            setDetailCharacter(null)
            handleEdit(detailCharacter)
          }}
          onChat={() => handleStartChat(detailCharacter)}
        />
      )}

      <ConfirmDialog
        open={!!deleteId}
        onClose={() => setDeleteId(null)}
        onConfirm={handleDelete}
        title="删除角色"
        message="确定要删除这个角色吗？将删除角色设定与封面；该角色下的会话记录会保留。此操作不可撤销。"
        confirmText="删除"
        danger
      />

      {/* 导入后世界书推荐（显式确认绑定，替代旧的静默自动绑定） */}
      <Modal
        open={!!lorebookSuggestions && lorebookSuggestions.length > 0}
        onClose={() => bindSuggestedLorebook(null)}
        title="检测到相关世界书"
        width="md"
      >
        <div className="space-y-3">
          <p className="text-sm text-tavern-text-muted">
            刚导入的角色可能与以下世界书相关，是否绑定？绑定后切换到该角色时会自动加载对应世界书。
          </p>
          {lorebookSuggestions?.map((s) => (
            <div
              key={s.id}
              className="flex items-center gap-3 p-3 rounded-lg bg-tavern-bg-soft border border-tavern-border"
            >
              <BookOpen className="w-5 h-5 text-tavern-accent shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium truncate">{s.name}</span>
                  <span className="text-[11px] px-1.5 py-0.5 rounded bg-tavern-accent-soft text-tavern-accent shrink-0">
                    匹配度 {s.score}
                  </span>
                </div>
                <p className="text-xs text-tavern-text-muted truncate mt-0.5">
                  {s.description || `${s.entryCount} 个条目`}
                </p>
              </div>
              <button
                className="btn-secondary text-xs shrink-0"
                onClick={() => bindSuggestedLorebook(s.id)}
              >
                绑定
              </button>
            </div>
          ))}
          <div className="flex justify-end pt-1">
            <button className="btn-secondary" onClick={() => bindSuggestedLorebook(null)}>
              暂不绑定
            </button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
