import { useEffect, useMemo, useState } from 'react'
import { Modal } from '../components/common/Modal'
import { EmptyState } from '../components/common/EmptyState'
import { ConfirmDialog } from '../components/common/ConfirmDialog'
import { cn } from '../lib/utils'
import { MessageSquarePlus, Plus, Trash2, Pencil, Upload, Download, Keyboard } from 'lucide-react'
import type { QuickReply, QuickReplyStore, Character, Preset } from '../../shared/types'
import { createQuickReply } from '../utils/quickReply'
import { listMacros } from '../utils/macros'

const actionLabels = { text: '发送文本', preset: '切换预设', command: '斜杠命令' } as const

interface EditingEntry {
  scope: 'global' | 'character'
  characterId?: string
  qr: QuickReply
}

export function QuickRepliesPage() {
  const [store, setStore] = useState<QuickReplyStore>({ global: [], byCharacter: {} })
  const [characters, setCharacters] = useState<Character[]>([])
  const [presets, setPresets] = useState<Preset[]>([])
  const [editing, setEditing] = useState<EditingEntry | null>(null)
  const [deleteKey, setDeleteKey] = useState<{ scope: 'global' | 'character'; characterId?: string; id: string } | null>(null)
  const [busyMsg, setBusyMsg] = useState<string | null>(null)

  const macros = useMemo(() => listMacros(), [])

  const load = async () => {
    const [s, cs, ps] = await Promise.all([
      window.api.quickReply.listAll(),
      window.api.character.list(),
      window.api.preset.list(),
    ])
    setStore(s)
    setCharacters(cs)
    setPresets(ps)
  }

  useEffect(() => {
    load()
  }, [])

  const persist = async (next: QuickReplyStore) => {
    setStore(next)
    await window.api.quickReply.saveAll(next)
  }

  const handleNew = (scope: 'global' | 'character', characterId?: string) => {
    setEditing({ scope, characterId, qr: createQuickReply() })
  }

  const handleSave = async () => {
    if (!editing) return
    const qr = editing.qr
    const next: QuickReplyStore = { ...store, byCharacter: { ...store.byCharacter } }
    if (editing.scope === 'global') {
      const idx = next.global.findIndex((q) => q.id === qr.id)
      if (idx >= 0) next.global[idx] = qr
      else next.global.push(qr)
    } else if (editing.characterId) {
      const list = next.byCharacter[editing.characterId] ?? []
      const idx = list.findIndex((q) => q.id === qr.id)
      if (idx >= 0) list[idx] = qr
      else list.push(qr)
      next.byCharacter[editing.characterId] = list
    }
    await persist(next)
    setEditing(null)
  }

  const handleDelete = async () => {
    if (!deleteKey) return
    const next: QuickReplyStore = { ...store, byCharacter: { ...store.byCharacter } }
    if (deleteKey.scope === 'global') {
      next.global = next.global.filter((q) => q.id !== deleteKey.id)
    } else if (deleteKey.characterId) {
      next.byCharacter[deleteKey.characterId] = (next.byCharacter[deleteKey.characterId] ?? []).filter((q) => q.id !== deleteKey.id)
    }
    await persist(next)
    setDeleteKey(null)
  }

  const handleExport = async () => {
    setBusyMsg('导出中...')
    try {
      const r = await window.api.quickReply.exportJson()
      if (r.error) setBusyMsg(`导出失败：${r.error}`)
      else setBusyMsg(null)
    } finally { setBusyMsg(null) }
  }

  const handleImport = async () => {
    setBusyMsg('导入中...')
    try {
      const r = await window.api.quickReply.importJson()
      if (r.error) setBusyMsg(`导入失败：${r.error}`)
      else { setBusyMsg(null); await load() }
    } finally { setBusyMsg(null) }
  }

  /** 渲染一条快捷回复卡片 */
  const renderRow = (qr: QuickReply, scope: 'global' | 'character', characterId?: string) => (
    <div key={`${scope}-${characterId ?? 'g'}-${qr.id}`} className="card p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className={cn('w-2 h-2 rounded-full shrink-0', qr.enabled ? 'bg-tavern-accent' : 'bg-tavern-text-muted')} />
          <span className="font-medium truncate">{qr.label}</span>
          <span className="px-1.5 py-0.5 rounded text-xs bg-tavern-bg-hover text-tavern-text-muted shrink-0">
            {actionLabels[qr.action]}
          </span>
          {qr.action === 'text' && (
            <span className="px-1.5 py-0.5 rounded text-xs bg-tavern-bg-hover text-tavern-text-muted shrink-0">
              {qr.sendWithAI ? '触发 AI' : '仅发送'}
            </span>
          )}
          {qr.hotkey != null && (
            <span className="px-1.5 py-0.5 rounded text-xs bg-tavern-accent-soft text-tavern-accent flex items-center gap-0.5 shrink-0">
              <Keyboard className="w-3 h-3" /> Ctrl+{qr.hotkey}
            </span>
          )}
        </div>
        <div className="flex gap-1 shrink-0">
          <button onClick={() => setEditing({ scope, characterId, qr: { ...qr } })} className="p-1.5 rounded text-tavern-text-muted hover:text-tavern-text hover:bg-tavern-bg-hover">
            <Pencil className="w-4 h-4" />
          </button>
          <button onClick={() => setDeleteKey({ scope, characterId, id: qr.id })} className="p-1.5 rounded text-tavern-text-muted hover:text-tavern-danger hover:bg-tavern-bg-hover">
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>
      <div className="text-sm text-tavern-text-muted font-mono line-clamp-2 whitespace-pre-wrap">
        {qr.content || <span className="text-tavern-text-muted/50">（空内容）</span>}
      </div>
    </div>
  )

  const characterGroups = Object.entries(store.byCharacter)

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <header className="flex items-center justify-between px-4 h-14 border-b border-tavern-border-soft bg-tavern-bg-soft shrink-0">
        <h1 className="font-display text-lg font-bold">快捷回复</h1>
        <div className="flex items-center gap-2">
          <button onClick={handleImport} className="btn-secondary">
            <Upload className="w-4 h-4" />
            导入
          </button>
          <button onClick={handleExport} className="btn-secondary">
            <Download className="w-4 h-4" />
            导出
          </button>
          <button onClick={() => handleNew('global')} className="btn-primary">
            <Plus className="w-4 h-4" />
            新建
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-4">
        {busyMsg && <div className="mb-3 text-sm text-tavern-text-muted">{busyMsg}</div>}
        {store.global.length === 0 && characterGroups.length === 0 ? (
          <EmptyState
            icon={<MessageSquarePlus className="w-8 h-8" />}
            title="暂无快捷回复"
            description="一键发送问候语、动作或触发指令，支持宏展开（{{time}} / {{random:...}} 等）"
            action={
              <button className="btn-primary" onClick={() => handleNew('global')}>
                <Plus className="w-4 h-4" />
                新建快捷回复
              </button>
            }
          />
        ) : (
          <div className="max-w-3xl mx-auto space-y-5">
            {/* 全局 */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-medium text-tavern-text-muted">全局（所有角色可用）</h3>
                <button className="btn-ghost text-xs text-tavern-accent" onClick={() => handleNew('global')}>
                  <Plus className="w-3 h-3" />
                  添加
                </button>
              </div>
              <div className="space-y-2">
                {store.global.length === 0
                  ? <div className="text-xs text-tavern-text-muted/60 px-1">暂无全局快捷回复</div>
                  : store.global.map((qr) => renderRow(qr, 'global'))}
              </div>
            </div>

            {/* 角色级 */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-medium text-tavern-text-muted">角色专属（绑定角色）</h3>
                <select
                  className="input text-xs py-1 px-2 w-44"
                  value=""
                  onChange={(e) => {
                    const id = e.target.value
                    if (id) handleNew('character', id)
                  }}
                >
                  <option value="">+ 为角色添加...</option>
                  {characters.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
              {characterGroups.length === 0 ? (
                <div className="text-xs text-tavern-text-muted/60 px-1">暂无角色专属快捷回复，从下拉选择角色添加</div>
              ) : (
                <div className="space-y-3">
                  {characterGroups.map(([charId, list]) => {
                    const char = characters.find((c) => c.id === charId)
                    return (
                      <div key={charId}>
                        <div className="text-xs text-tavern-text-soft mb-1.5">{char?.name ?? charId}</div>
                        <div className="space-y-2">{list.map((qr) => renderRow(qr, 'character', charId))}</div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* 编辑 Modal */}
      <Modal open={!!editing} onClose={() => setEditing(null)} title="编辑快捷回复" width="xl">
        {editing && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">按钮名称</label>
                <input
                  type="text"
                  className="input"
                  value={editing.qr.label}
                  onChange={(e) => setEditing({ ...editing, qr: { ...editing.qr, label: e.target.value } })}
                  placeholder="如：早安问候"
                />
              </div>
              <div>
                <label className="label">动作类型</label>
                <div className="flex gap-2">
                  {(['text', 'preset', 'command'] as const).map((action) => (
                    <button
                      key={action}
                      onClick={() => setEditing({ ...editing, qr: { ...editing.qr, action } })}
                      className={cn(
                        'px-3 py-1.5 rounded-lg text-sm transition-colors',
                        editing.qr.action === action
                          ? 'bg-tavern-accent text-tavern-bg'
                          : 'bg-tavern-bg-hover text-tavern-text-muted hover:text-tavern-text'
                      )}
                    >
                      {actionLabels[action]}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {editing.qr.action === 'preset' ? (
              <div>
                <label className="label">目标预设</label>
                <select
                  className="select"
                  value={editing.qr.presetId ?? ''}
                  onChange={(e) => setEditing({ ...editing, qr: { ...editing.qr, presetId: e.target.value } })}
                >
                  <option value="">选择预设...</option>
                  {presets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
            ) : editing.qr.action === 'command' ? (
              <div>
                <label className="label">命令文本（含 /）</label>
                <input
                  type="text"
                  className="input font-mono"
                  value={editing.qr.command ?? ''}
                  onChange={(e) => setEditing({ ...editing, qr: { ...editing.qr, command: e.target.value } })}
                  placeholder="/help 或 /imagine 一只猫"
                />
              </div>
            ) : (
              <>
                <div>
                  <label className="label">发送内容（支持宏）</label>
                  <textarea
                    className="textarea min-h-[80px]"
                    value={editing.qr.content}
                    onChange={(e) => setEditing({ ...editing, qr: { ...editing.qr, content: e.target.value } })}
                    placeholder="{{random:早安|晚安}} {{char}}，今天天气真好~"
                  />
                  {/* 宏快捷插入 */}
                  <div className="flex flex-wrap gap-1 mt-2">
                    {macros.map((m) => (
                      <button
                        key={m.name}
                        title={`${m.description} ｜ 例：${m.example}`}
                        className="px-1.5 py-0.5 rounded bg-tavern-bg-hover text-xs text-tavern-text-muted hover:text-tavern-accent hover:bg-tavern-accent-soft transition-colors"
                        onClick={() => setEditing({
                          ...editing,
                          qr: { ...editing.qr, content: editing.qr.content + `{{${m.name}${m.name === 'random' ? ':选项A|选项B' : ''}}}` },
                        })}
                      >
                        {'{{'}{m.name}{'}}'}
                      </button>
                    ))}
                  </div>
                </div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={editing.qr.sendWithAI}
                    onChange={(e) => setEditing({ ...editing, qr: { ...editing.qr, sendWithAI: e.target.checked } })}
                    className="accent-[var(--color-accent)]"
                  />
                  <span className="text-sm">发送后触发 AI 回复（关闭 = 仅发送消息）</span>
                </label>
              </>
            )}

            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="label">快捷键（Ctrl+数字）</label>
                <select
                  className="select"
                  value={editing.qr.hotkey ?? ''}
                  onChange={(e) => setEditing({ ...editing, qr: { ...editing.qr, hotkey: e.target.value ? Number(e.target.value) : undefined } })}
                >
                  <option value="">无</option>
                  {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </div>
              <div>
                <label className="label">排序</label>
                <input
                  type="number"
                  className="input"
                  value={editing.qr.order}
                  onChange={(e) => setEditing({ ...editing, qr: { ...editing.qr, order: Number(e.target.value) || 0 } })}
                />
              </div>
              <div className="flex items-end pb-1">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={editing.qr.enabled}
                    onChange={(e) => setEditing({ ...editing, qr: { ...editing.qr, enabled: e.target.checked } })}
                    className="accent-[var(--color-accent)]"
                  />
                  <span className="text-sm">启用</span>
                </label>
              </div>
            </div>

            <div className="flex justify-end gap-2">
              <button onClick={() => setEditing(null)} className="btn-secondary">取消</button>
              <button onClick={handleSave} className="btn-primary">保存</button>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={!!deleteKey}
        onClose={() => setDeleteKey(null)}
        onConfirm={handleDelete}
        title="删除快捷回复"
        message="确定要删除这条快捷回复吗？"
        confirmText="删除"
        danger
      />
    </div>
  )
}
