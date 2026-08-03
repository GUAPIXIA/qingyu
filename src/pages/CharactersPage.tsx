import { useState, useMemo, useEffect, useCallback, useDeferredValue } from "react"
import { useNavigate } from "react-router-dom"
import { useCharacterStore } from "../store/useCharacterStore"
import { CharacterCard } from "../components/character/CharacterCard"
import { CharacterEditor } from "../components/character/CharacterEditor"
import { CharacterDetail } from "../components/character/CharacterDetail"
import { EmptyState } from "../components/common/EmptyState"
import { ConfirmDialog } from "../components/common/ConfirmDialog"
import { cn } from "../lib/utils"
import { Users, Plus, Upload, FileUp, Search, AlertCircle, X, FileStack, CheckCircle, Info, Grid3X3, List, Loader2, FileWarning, ArrowDownUp, Sparkles } from "lucide-react"
import type { Character } from "../../shared/types"

type CardSize = "sm" | "md" | "lg"
type SortKey = "updatedAt" | "createdAt" | "name"

function loadCardSize(): CardSize {
  try { return (localStorage.getItem("char-card-size") as CardSize) || "md" } catch { return "md" }
}

export function CharactersPage() {
  const navigate = useNavigate()
  const { characters, selectCharacter, deleteCharacter, importPng, importJson, importBatch, saveCharacter, createCharacter, importError, importNotice, pendingAvatarId, importProgress } = useCharacterStore()
  const [editing, setEditing] = useState(false)
  const [editCharacter, setEditCharacter] = useState<Character | null>(null)
  const [search, setSearch] = useState("")
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid")
  const [cardSize, setCardSize] = useState<CardSize>(loadCardSize)
  const [sortKey, setSortKey] = useState<SortKey>("updatedAt")
  const [detailCharacter, setDetailCharacter] = useState<Character | null>(null)
  const [batchResult, setBatchResult] = useState<{ total: number; successCount: number; failCount: number; fails: { name: string; error: string }[] } | null>(null)

  const deferredSearch = useDeferredValue(search)

  const filtered = useMemo(() => {
    let result = characters
    if (deferredSearch) {
      const q = deferredSearch.toLowerCase()
      result = result.filter((c) => {
        const nameMatch = c.name.toLowerCase().includes(q)
        const tagMatch = c.tags.some((t) => t.toLowerCase().includes(q))
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

  const handleNew = () => {
    setEditCharacter(createCharacter())
    setEditing(true)
  }

  const handleEdit = useCallback((char: Character) => {
    setEditCharacter({ ...char })
    setEditing(true)
  }, [])

  const handleSave = async (char: Character) => {
    await saveCharacter(char)
    setEditing(false)
    setEditCharacter(null)
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

  const handleBatchImport = async () => {
    const result = await importBatch()
    if (result) {
      const fails = (result.results || [])
        .filter(r => !r.success)
        .map(r => ({ name: r.name, error: r.error || "未知错误" }))
      setBatchResult({
        total: result.total || 0,
        successCount: result.successCount || 0,
        failCount: result.failCount || 0,
        fails,
      })
      setTimeout(() => setBatchResult(null), 8000)
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
          batchResult.failCount > 0
            ? "bg-amber-500/10 border-amber-500/30 text-amber-600"
            : "bg-emerald-500/10 border-emerald-500/30 text-emerald-600"
        )}>
          {batchResult.failCount > 0 ? (
            <Info className="w-4 h-4 shrink-0" />
          ) : (
            <CheckCircle className="w-4 h-4 shrink-0" />
          )}
          <span className="flex-1">
            批量导入完成：成功 <strong>{batchResult.successCount}</strong> 个
            {batchResult.failCount > 0 && (
              <>，失败 <strong>{batchResult.failCount}</strong> 个
                {batchResult.fails.length > 0 && (
                  <span className="ml-1 text-tavern-text-muted">
                    （{batchResult.fails.map(f => f.name).join("、")}）
                  </span>
                )}
              </>
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
          <button onClick={handleNew} className="btn-primary">
            <Plus className="w-4 h-4" />
            新建角色
          </button>
          <button onClick={() => importPng()} className="btn-secondary" title="导入 PNG 角色卡">
            <FileUp className="w-4 h-4" />
            PNG
          </button>
          <button onClick={() => importJson()} className="btn-secondary" title="导入 JSON 角色卡">
            <Upload className="w-4 h-4" />
            JSON
          </button>
          <button onClick={handleBatchImport} className="btn-secondary" title="批量导入角色卡">
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
        {characters.length === 0 ? (
          <EmptyState
            className="h-full"
            icon={<Users className="w-8 h-8" />}
            title="还没有角色"
            description="创建你的第一个角色，或从 SillyTavern 导入角色卡"
            action={
              <div className="flex gap-2">
                <button className="btn-primary" onClick={handleNew}>
                  <Plus className="w-4 h-4" />
                  新建角色
                </button>
                <button className="btn-secondary" onClick={() => importPng()}>
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
        message="确定要删除这个角色吗？相关的对话记录也将被删除。此操作不可撤销。"
        confirmText="删除"
        danger
      />
    </div>
  )
}