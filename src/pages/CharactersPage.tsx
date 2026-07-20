import { useState, useMemo, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useCharacterStore } from '../store/useCharacterStore'
import { CharacterCard } from '../components/character/CharacterCard'
import { CharacterEditor } from '../components/character/CharacterEditor'
import { EmptyState } from '../components/common/EmptyState'
import { ConfirmDialog } from '../components/common/ConfirmDialog'
import { cn } from '../lib/utils'
import { Users, Plus, Upload, FileUp, Search, MessageSquare, AlertCircle, X, FileStack, CheckCircle, Info, Grid3X3, List, Loader2, FileWarning } from 'lucide-react'
import type { Character } from '../../shared/types'

export function CharactersPage() {
  const navigate = useNavigate()
  const { characters, selectCharacter, deleteCharacter, importPng, importJson, importBatch, saveCharacter, createCharacter, importError, pendingAvatarId, importProgress } = useCharacterStore()
  const [editing, setEditing] = useState(false)
  const [editCharacter, setEditCharacter] = useState<Character | null>(null)
  const [search, setSearch] = useState('')
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid')
  const [batchResult, setBatchResult] = useState<{ total: number; successCount: number; failCount: number; fails: { name: string; error: string }[] } | null>(null)

  const filtered = useMemo(() => {
    if (!search) return characters
    const q = search.toLowerCase()
    return characters.filter(
      (c) => c.name.toLowerCase().includes(q) || c.tags.some((t) => t.toLowerCase().includes(q))
    )
  }, [characters, search])

  const handleNew = () => {
    setEditCharacter(createCharacter())
    setEditing(true)
  }

  const handleEdit = (char: Character) => {
    setEditCharacter({ ...char })
    setEditing(true)
  }

  const handleSave = async (char: Character) => {
    await saveCharacter(char)
    setEditing(false)
    setEditCharacter(null)
  }

  const handleStartChat = (char: Character) => {
    selectCharacter(char.id)
    navigate('/chat')
  }

  const handleDelete = async () => {
    if (deleteId) {
      await deleteCharacter(deleteId)
      setDeleteId(null)
    }
  }

  // JSON 导入无头像时自动打开编辑器
  useEffect(() => {
    if (pendingAvatarId) {
      const char = characters.find(c => c.id === pendingAvatarId)
      if (char) {
        handleEdit(char)
        useCharacterStore.setState({ pendingAvatarId: null })
      }
    }
  }, [pendingAvatarId, characters])

  const handleBatchImport = async () => {
    const result = await importBatch()
    if (result) {
      const fails = (result.results || [])
        .filter(r => !r.success)
        .map(r => ({ name: r.name, error: r.error || '未知错误' }))
      setBatchResult({
        total: result.total || 0,
        successCount: result.successCount || 0,
        failCount: result.failCount || 0,
        fails,
      })
      // 5秒后自动清除
      setTimeout(() => setBatchResult(null), 8000)
    }
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* 导入错误提示 */}
      {importError && (
        <div className="flex items-center gap-2 px-4 py-2 bg-tavern-danger/10 border-b border-tavern-danger/30 text-tavern-danger text-sm animate-fade-in">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span className="flex-1">{importError}</span>
          <button onClick={() => useCharacterStore.setState({ importError: null })} className="p-0.5 hover:opacity-70">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* 批量导入结果 */}
      {batchResult && (
        <div className={cn(
          'flex items-center gap-2 px-4 py-2 border-b text-sm animate-fade-in',
          batchResult.failCount > 0
            ? 'bg-amber-500/10 border-amber-500/30 text-amber-600'
            : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-600'
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
                    （{batchResult.fails.map(f => f.name).join('、')}）
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

      {/* 导入进度条 */}
      {importProgress && (
        <div className="px-4 py-3 border-b border-tavern-border-soft bg-tavern-bg-soft animate-fade-in">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2 text-sm">
              {importProgress.status === 'processing' ? (
                <Loader2 className="w-4 h-4 animate-spin text-tavern-accent" />
              ) : importProgress.status === 'error' ? (
                <FileWarning className="w-4 h-4 text-tavern-danger" />
              ) : (
                <CheckCircle className="w-4 h-4 text-emerald-500" />
              )}
              <span className="text-tavern-text-soft">
                导入中 <strong>{importProgress.current}</strong> / {importProgress.total}
              </span>
            </div>
            <span className={cn(
              'text-xs truncate ml-4 max-w-[50%]',
              importProgress.status === 'error' ? 'text-tavern-danger' : 'text-tavern-text-muted'
            )}>
              {importProgress.fileName}
            </span>
          </div>
          {/* 进度条本体 */}
          <div className="w-full h-2 rounded-full bg-tavern-bg-hover overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-300 ease-out"
              style={{
                width: `${Math.round((importProgress.current / importProgress.total) * 100)}%`,
                background: importProgress.status === 'error'
                  ? 'linear-gradient(90deg, #ef4444, #f87171)'
                  : 'linear-gradient(90deg, #d4a574, #e8b88a)',
              }}
            />
          </div>
          {/* 百分比数字 */}
          <div className="text-xs text-tavern-text-muted text-right mt-0.5">
            {Math.round((importProgress.current / importProgress.total) * 100)}%
          </div>
        </div>
      )}

      {/* 顶栏 */}
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

      {/* 搜索栏 */}
      {characters.length > 0 && (
        <div className="px-4 py-3 border-b border-tavern-border-soft flex items-center gap-3">
          <div className="relative max-w-xs flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-tavern-text-muted" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索角色或标签..."
              className="input pl-9"
            />
          </div>
          {/* 视图切换 */}
          <div className="flex items-center gap-0.5 bg-tavern-bg-hover rounded-lg p-0.5">
            <button
              onClick={() => setViewMode('grid')}
              className={cn('p-1.5 rounded transition-colors', viewMode === 'grid' ? 'bg-tavern-bg-card shadow-sm text-tavern-accent' : 'text-tavern-text-muted hover:text-tavern-text')}
              title="网格视图"
            >
              <Grid3X3 className="w-4 h-4" />
            </button>
            <button
              onClick={() => setViewMode('list')}
              className={cn('p-1.5 rounded transition-colors', viewMode === 'list' ? 'bg-tavern-bg-card shadow-sm text-tavern-accent' : 'text-tavern-text-muted hover:text-tavern-text')}
              title="列表视图"
            >
              <List className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* 角色列表 */}
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
        ) : viewMode === 'list' ? (
          <div className="flex flex-col gap-3 max-w-3xl mx-auto">
            {filtered.map((char) => (
              <CharacterCard
                key={char.id}
                character={char}
                viewMode="list"
                onEdit={() => handleEdit(char)}
                onDelete={() => setDeleteId(char.id)}
                onChat={() => handleStartChat(char)}
              />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {filtered.map((char) => (
              <CharacterCard
                key={char.id}
                character={char}
                onEdit={() => handleEdit(char)}
                onDelete={() => setDeleteId(char.id)}
                onChat={() => handleStartChat(char)}
              />
            ))}
          </div>
        )}
      </div>

      {/* 编辑器 */}
      {editing && editCharacter && (
        <CharacterEditor
          character={editCharacter}
          onSave={handleSave}
          onClose={() => { setEditing(false); setEditCharacter(null) }}
        />
      )}

      {/* 删除确认 */}
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
