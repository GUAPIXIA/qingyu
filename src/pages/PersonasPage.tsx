import React, { useEffect, useRef, useState } from 'react'
import { nanoid } from 'nanoid'
import { Modal } from '../components/common/Modal'
import { EmptyState } from '../components/common/EmptyState'
import { ConfirmDialog } from '../components/common/ConfirmDialog'
import { cn } from '../lib/utils'
import { UserCircle, Plus, Trash2, Pencil, Check, Star, Search, Download, Upload } from 'lucide-react'
import type { Persona } from '../../shared/types'
import { useSettingsStore } from '../store/useSettingsStore'
import { usePersonaStore } from '../store/usePersonaStore'

export function PersonasPage() {
  const { settings, updateSettings } = useSettingsStore()
  const { personas, loadPersonas: storeLoadPersonas, savePersona, deletePersona: storeDeletePersona } = usePersonaStore()
  const [editing, setEditing] = useState<Persona | null>(null)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [search, setSearch] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  const showToast = (msg: string) => {
    setToast(msg)
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    toastTimerRef.current = setTimeout(() => setToast(null), 3000)
  }

  // 默认身份置顶显示
  const sortedPersonas = [...personas].sort((a, b) => {
    const aDefault = settings.defaultPersonaId === a.id ? 1 : 0
    const bDefault = settings.defaultPersonaId === b.id ? 1 : 0
    return bDefault - aDefault
  })

  const loadPersonasAndInit = async () => {
    await storeLoadPersonas()
    const list = usePersonaStore.getState().personas
    // 首次使用：自动创建默认身份
    if (list.length === 0) {
      const defaultPersona: Persona = {
        id: nanoid(),
        name: settings.userName || '用户',
        description: settings.userDescription || '',
        persona: settings.userPersona || '',
        avatar: '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      await savePersona(defaultPersona)
      updateSettings({ activePersonaId: defaultPersona.id })
    } else {
      // 如果没有激活的身份，激活第一个
      if (!settings.activePersonaId && list.length > 0) {
        activatePersona(list[0])
      }
    }
  }

  useEffect(() => {
    loadPersonasAndInit()
    return () => { if (toastTimerRef.current) clearTimeout(toastTimerRef.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const activatePersona = (p: Persona) => {
    updateSettings({
      activePersonaId: p.id,
      userName: p.name,
      userDescription: p.description,
      userPersona: p.persona,
    })
  }

  const handleNew = () => {
    setEditing({
      id: nanoid(),
      name: '新身份',
      description: '',
      persona: '',
      avatar: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  }

  const handleSave = async () => {
    if (!editing) return
    await savePersona(editing)
    setEditing(null)
    // 如果是当前激活的身份，同步更新 settings
    if (settings.activePersonaId === editing.id) {
      activatePersona(editing)
    }
  }

  const handleAvatarSelect = async () => {
    const path = await window.api.file.selectImage()
    if (path) {
      const base64 = await window.api.file.readImageAsBase64(path)
      setEditing(prev => prev ? { ...prev, avatar: base64 } : null)
    }
  }

  const handleDelete = async () => {
    if (!deleteId) return
    await storeDeletePersona(deleteId)
    // 如果删除的是当前激活身份，切换到第一个
    if (settings.activePersonaId === deleteId) {
      const remaining = usePersonaStore.getState().personas
      if (remaining.length > 0) {
        activatePersona(remaining[0])
      } else {
        updateSettings({ activePersonaId: null, userName: '用户', userDescription: '', userPersona: '' })
      }
    }
    // 如果删除的是默认身份，清除
    if (settings.defaultPersonaId === deleteId) {
      updateSettings({ defaultPersonaId: null })
    }
    setDeleteId(null)
  }

  // 切换默认身份（星标）：可设置也可取消
  const handleToggleDefault = (p: Persona) => {
    const isDefault = settings.defaultPersonaId === p.id
    updateSettings({ defaultPersonaId: isDefault ? null : p.id })
    showToast(isDefault
      ? `已取消「${p.name}」的默认身份`
      : `已将「${p.name}」设为默认身份，新建对话将默认使用`)
  }

  const filtered = search.trim()
    ? sortedPersonas.filter(p => p.name.toLowerCase().includes(search.toLowerCase()) || p.description.toLowerCase().includes(search.toLowerCase()) || p.persona.toLowerCase().includes(search.toLowerCase()))
    : sortedPersonas

  const handleExport = () => {
    const blob = new Blob([JSON.stringify(personas, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = `personas-${Date.now()}.json`; a.click(); URL.revokeObjectURL(url)
    showToast(`已导出 ${personas.length} 个身份`)
  }
  const handleImportClick = () => fileInputRef.current?.click()
  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement> & { target: HTMLInputElement }) => {
    const file = e.target.files?.[0]; if (!file) return
    try {
      const text = await file.text(); const data = JSON.parse(text)
      const list: Persona[] = Array.isArray(data) ? data : data.personas ?? []
      let count = 0
      for (const p of list) {
        if (!p.name) continue
        const persona: Persona = { id: nanoid(), name: String(p.name), description: String(p.description ?? ''), persona: String(p.persona ?? ''), avatar: String(p.avatar ?? ''), createdAt: Date.now(), updatedAt: Date.now() }
        await savePersona(persona); count++
      }
      showToast(`已导入 ${count} 个身份`)
    } catch (err) { showToast(`导入失败：${(err as Error).message}`) }
    e.target.value = ''
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <header className="flex items-center justify-between px-4 h-14 border-b border-tavern-border-soft bg-tavern-bg-soft shrink-0 gap-2">
        <div className="flex items-center gap-3">
          <h1 className="font-display text-lg font-bold">用户身份</h1>
          <span className="hidden sm:inline text-xs text-tavern-text-muted" title="当前身份作用于当前会话，默认身份作用于新建会话">当前 vs 默认</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="hidden sm:flex items-center gap-1.5 bg-tavern-bg rounded-lg px-2 py-1 border border-tavern-border-soft">
            <Search className="w-3.5 h-3.5 text-tavern-text-muted" aria-hidden />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索身份..." className="bg-transparent outline-none text-sm w-32 placeholder:text-tavern-text-muted" aria-label="搜索身份" />
          </div>
          <button onClick={handleImportClick} className="btn-ghost text-sm" aria-label="导入身份"><Upload className="w-4 h-4" /> 导入</button>
          <button onClick={handleExport} className="btn-ghost text-sm" aria-label="导出身份"><Download className="w-4 h-4" /> 导出</button>
          <input ref={fileInputRef} type="file" accept=".json" className="hidden" onChange={handleImportFile} />
          <button onClick={handleNew} className="btn-primary" aria-label="新建身份">
            <Plus className="w-4 h-4" />
            新建身份
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-4">
        {/* 移动端搜索 */}
        <div className="sm:hidden mb-3 flex items-center gap-2 bg-tavern-bg rounded-lg px-3 py-2 border border-tavern-border-soft">
          <Search className="w-4 h-4 text-tavern-text-muted" aria-hidden />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索身份..." className="flex-1 bg-transparent outline-none text-sm" aria-label="搜索身份" />
        </div>
        {filtered.length === 0 && personas.length > 0 ? (
          <div className="text-center py-10 text-sm text-tavern-text-muted">无匹配身份</div>
        ) : personas.length === 0 ? (
          <EmptyState
            icon={<UserCircle className="w-8 h-8" />}
            title="暂无用户身份"
            description="创建多个身份，在不同场景下切换你的角色设定"
          />
        ) : (
          <div className="max-w-3xl mx-auto grid grid-cols-1 sm:grid-cols-2 gap-3">
            {filtered.map((p) => {
              const isActive = settings.activePersonaId === p.id
              return (
                <div
                  key={p.id}
                  className={cn(
                    'card p-4 cursor-pointer transition-all',
                    isActive ? 'border-tavern-accent ring-1 ring-tavern-accent/30' : 'hover:border-tavern-accent/50'
                  )}
                  onClick={() => activatePersona(p)}
                >
                  <div className="flex items-start gap-3">
                    {/* 头像 */}
                    <div className="w-14 h-14 rounded-full bg-tavern-bg-hover flex items-center justify-center shrink-0 overflow-hidden">
                      {p.avatar ? (
                        <img src={p.avatar} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <UserCircle className="w-9 h-9 text-tavern-text-muted" />
                      )}
                    </div>

                    {/* 信息 */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-tavern-text truncate">{p.name}</span>
                        {isActive && (
                          <span className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-xs bg-tavern-accent-soft text-tavern-accent shrink-0">
                            <Check className="w-3 h-3" />
                            当前
                          </span>
                        )}
                        {settings.defaultPersonaId === p.id && (
                          <span className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-xs bg-tavern-warning/15 text-tavern-warning shrink-0">
                            <Star className="w-3 h-3" />
                            默认
                          </span>
                        )}
                      </div>
                      {p.description && (
                        <p className="text-xs text-tavern-text-muted mt-1 line-clamp-2">{p.description}</p>
                      )}
                      {p.persona && (
                        <p className="text-xs text-tavern-text-muted mt-0.5">性格：{p.persona}</p>
                      )}
                    </div>

                    {/* 操作 */}
                    <div className="flex gap-1 shrink-0">
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          handleToggleDefault(p)
                        }}
                        className={cn(
                          'p-1.5 rounded text-xs transition-colors',
                          settings.defaultPersonaId === p.id
                            ? 'text-tavern-warning bg-tavern-warning/15'
                            : 'text-tavern-text-muted hover:text-tavern-warning hover:bg-tavern-bg-hover'
                        )}
                        title={settings.defaultPersonaId === p.id ? '取消默认身份（新对话将不再默认使用）' : '设为默认身份（新建对话时默认使用）'}
                      >
                        <Star className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); setEditing({ ...p }) }}
                        className="p-1.5 rounded text-tavern-text-muted hover:text-tavern-text hover:bg-tavern-bg-hover"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); setDeleteId(p.id) }}
                        className="p-1.5 rounded text-tavern-text-muted hover:text-tavern-danger hover:bg-tavern-bg-hover"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* 编辑 Modal */}
      <Modal open={!!editing} onClose={() => setEditing(null)} title="编辑身份" width="lg">
        {editing && (
          <div className="space-y-4">
            {/* 头像 */}
            <div className="flex justify-center">
              <div
                className="w-20 h-20 rounded-full overflow-hidden bg-tavern-bg-hover border-2 border-tavern-border cursor-pointer relative group"
                onClick={handleAvatarSelect}
              >
                {editing.avatar ? (
                  <img src={editing.avatar} alt="" className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-tavern-text-muted">
                    <UserCircle className="w-10 h-10" />
                  </div>
                )}
                <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center rounded-full">
                  <span className="text-xs text-white">更换头像</span>
                </div>
              </div>
            </div>
            <div>
              <label className="label">名称（{'{{user}}'} 替换值）</label>
              <input
                type="text"
                className="input"
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                placeholder="你的名字"
              />
              <p className="text-xs text-tavern-text-muted mt-1">在角色卡和预设中，{'{{user}}'} 会被替换为此名字</p>
            </div>
            <div>
              <label className="label">描述</label>
              <textarea
                className="textarea"
                rows={3}
                value={editing.description}
                onChange={(e) => setEditing({ ...editing, description: e.target.value })}
                placeholder="描述你的身份、背景等，AI 会了解这些信息"
              />
            </div>
            <div>
              <label className="label">性格</label>
              <textarea
                className="textarea"
                rows={2}
                value={editing.persona}
                onChange={(e) => setEditing({ ...editing, persona: e.target.value })}
                placeholder="你的性格特征，如：友善、好奇、内向等"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setEditing(null)} className="btn-secondary">取消</button>
              <button onClick={handleSave} className="btn-primary">保存</button>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={!!deleteId}
        onClose={() => setDeleteId(null)}
        onConfirm={handleDelete}
        title="删除身份"
        message="确定要删除这个用户身份吗？"
        confirmText="删除"
        danger
      />

      {/* 操作反馈提示 */}
      {toast && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-lg bg-tavern-bg-soft border border-tavern-border shadow-xl text-sm text-tavern-text animate-in fade-in slide-in-from-top-2">
          {toast}
        </div>
      )}
    </div>
  )
}
