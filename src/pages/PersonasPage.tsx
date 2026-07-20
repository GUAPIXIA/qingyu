import { useEffect, useState } from 'react'
import { nanoid } from 'nanoid'
import { Modal } from '../components/common/Modal'
import { EmptyState } from '../components/common/EmptyState'
import { ConfirmDialog } from '../components/common/ConfirmDialog'
import { cn } from '../lib/utils'
import { UserCircle, Plus, Trash2, Pencil, Check, ImagePlus } from 'lucide-react'
import type { Persona } from '../../shared/types'
import { useSettingsStore } from '../store/useSettingsStore'

export function PersonasPage() {
  const { settings, updateSettings } = useSettingsStore()
  const [personas, setPersonas] = useState<Persona[]>([])
  const [editing, setEditing] = useState<Persona | null>(null)
  const [deleteId, setDeleteId] = useState<string | null>(null)

  const loadPersonas = () => {
    window.api.persona.list().then((list) => {
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
        window.api.persona.save(defaultPersona).then(() => {
          updateSettings({ activePersonaId: defaultPersona.id })
          setPersonas([defaultPersona])
        })
      } else {
        setPersonas(list)
        // 如果没有激活的身份，激活第一个
        if (!settings.activePersonaId && list.length > 0) {
          activatePersona(list[0])
        }
      }
    })
  }

  useEffect(() => {
    loadPersonas()
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
    await window.api.persona.save(editing)
    setEditing(null)
    loadPersonas()
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
    await window.api.persona.delete(deleteId)
    // 如果删除的是当前激活身份，切换到第一个
    if (settings.activePersonaId === deleteId) {
      const remaining = personas.filter((p) => p.id !== deleteId)
      if (remaining.length > 0) {
        activatePersona(remaining[0])
      } else {
        updateSettings({ activePersonaId: null, userName: '用户', userDescription: '', userPersona: '' })
      }
    }
    setDeleteId(null)
    loadPersonas()
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <header className="flex items-center justify-between px-4 h-14 border-b border-tavern-border-soft bg-tavern-bg-soft shrink-0">
        <h1 className="font-display text-lg font-bold">用户身份</h1>
        <button onClick={handleNew} className="btn-primary">
          <Plus className="w-4 h-4" />
          新建身份
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-4">
        {personas.length === 0 ? (
          <EmptyState
            icon={<UserCircle className="w-8 h-8" />}
            title="暂无用户身份"
            description="创建多个身份，在不同场景下切换你的角色设定"
          />
        ) : (
          <div className="max-w-3xl mx-auto grid grid-cols-1 sm:grid-cols-2 gap-3">
            {personas.map((p) => {
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
    </div>
  )
}
