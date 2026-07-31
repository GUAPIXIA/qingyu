import { useState, useEffect } from 'react'
import { X, ArrowUp, ArrowDown, AtSign, Repeat, Zap, ZapOff, BookOpen, FileText, Download, Palette } from 'lucide-react'
import { cn } from '../../lib/utils'
import { getDisplayName } from '../../utils/variables'
import { charAssetUrl } from '../../utils/asset'
import type { GroupChat, Character, Lorebook, Preset } from '../../../shared/types'

interface GroupChatSettingsPanelProps {
  group: GroupChat
  characters: Character[]
  lorebooks: Lorebook[]
  presets: Preset[]
  onClose: () => void
  onSave: (group: GroupChat) => void
  onDelete: () => void
  onAddMember: (charId: string) => void
  onRemoveMember: (charId: string) => void
  onMoveMember: (index: number, dir: number) => void
  onToggleLorebook: (id: string) => void
  onExport: () => void
}

/**
 * 群聊设置侧滑面板。
 * 从 GroupChatPage 中抽取，包含成员管理、世界书、预设、对话模式、背景、主题色等设置。
 */
export function GroupChatSettingsPanel({
  group,
  characters,
  lorebooks,
  presets,
  onClose,
  onSave,
  onDelete,
  onAddMember,
  onRemoveMember,
  onMoveMember,
  onToggleLorebook,
  onExport,
}: GroupChatSettingsPanelProps) {
  const availableChars = characters.filter(c => !group.memberIds.includes(c.id))

  // 滑块和文本域使用本地 state，避免拖动时频繁写盘
  const [localMaxRounds, setLocalMaxRounds] = useState(group.maxRounds)
  const [localSpeakerInterval, setLocalSpeakerInterval] = useState(group.speakerInterval)
  const [localSystemPrompt, setLocalSystemPrompt] = useState(group.systemPrompt)
  const [localOpacity, setLocalOpacity] = useState(group.chatBackgroundParams?.opacity ?? 0.3)
  const [localBlur, setLocalBlur] = useState(group.chatBackgroundParams?.blur ?? 0)
  const [localInputOpacity, setLocalInputOpacity] = useState(group.bubbleOpacity ?? 1)

  // group 变化时同步本地 state
  useEffect(() => { setLocalMaxRounds(group.maxRounds) }, [group.maxRounds])
  useEffect(() => { setLocalSpeakerInterval(group.speakerInterval) }, [group.speakerInterval])
  useEffect(() => { setLocalSystemPrompt(group.systemPrompt) }, [group.systemPrompt])
  useEffect(() => { setLocalOpacity(group.chatBackgroundParams?.opacity ?? 0.3) }, [group.chatBackgroundParams?.opacity])
  useEffect(() => { setLocalBlur(group.chatBackgroundParams?.blur ?? 0) }, [group.chatBackgroundParams?.blur])
  useEffect(() => { setLocalInputOpacity(group.bubbleOpacity ?? 1) }, [group.bubbleOpacity])

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div className="fixed right-0 top-0 bottom-0 w-80 z-50 bg-tavern-bg-card border-l border-tavern-border shadow-2xl overflow-y-auto">
        {/* 头部 */}
        <div className="sticky top-0 z-10 flex items-center justify-between px-4 py-3 bg-tavern-bg-card/90 backdrop-blur border-b border-tavern-border-soft">
          <h3 className="text-sm font-semibold text-tavern-text">群聊设置</h3>
          <button className="btn-ghost p-1.5" onClick={onClose}>
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-5">
          {/* 成员管理 */}
          <div>
            <label className="label">成员管理</label>
            <div className="space-y-1 mt-1">
              {group.memberIds.map((id, idx) => {
                const char = characters.find(c => c.id === id)
                if (!char) return null
                return (
                  <div key={id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-tavern-bg-soft text-sm">
                    <span className="w-5 text-xs text-tavern-text-muted text-center">{idx + 1}</span>
                    {(char.avatar || charAssetUrl(char.id, 'avatar', char.updatedAt)) ? (
                      <img src={char.avatar || charAssetUrl(char.id, 'avatar', char.updatedAt)} className="w-6 h-6 rounded-full object-cover" alt="" />
                    ) : (
                      <div className="w-6 h-6 rounded-full bg-tavern-bg-hover flex items-center justify-center text-[10px] font-bold">
                        {char.translatedContent?.name?.[0] ?? char.name[0]}
                      </div>
                    )}
                    <span className="flex-1 text-sm truncate">{getDisplayName(char)}</span>
                    {idx === group.currentSpeakerIndex && (
                      <span className="text-[10px] text-tavern-accent">当前</span>
                    )}
                    <button onClick={() => onMoveMember(idx, -1)} disabled={idx === 0} className="p-0.5 text-tavern-text-muted hover:text-tavern-text disabled:opacity-30">
                      <ArrowUp className="w-3 h-3" />
                    </button>
                    <button onClick={() => onMoveMember(idx, 1)} disabled={idx === group.memberIds.length - 1} className="p-0.5 text-tavern-text-muted hover:text-tavern-text disabled:opacity-30">
                      <ArrowDown className="w-3 h-3" />
                    </button>
                    <button onClick={() => onRemoveMember(id)} className="p-0.5 text-tavern-text-muted hover:text-tavern-danger">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )
              })}
            </div>

            {availableChars.length > 0 && (
              <div className="mt-2">
                <select
                  onChange={e => { if (e.target.value) onAddMember(e.target.value); e.target.value = '' }}
                  className="w-full bg-tavern-bg border border-tavern-border-soft rounded-lg px-2.5 py-1.5 text-xs text-tavern-text outline-none focus:border-tavern-accent"
                  defaultValue=""
                >
                  <option value="" disabled>+ 添加成员...</option>
                  {availableChars.map(c => (
                    <option key={c.id} value={c.id}>{getDisplayName(c)}</option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {/* 世界书 */}
          {lorebooks.length > 0 && (
            <div>
              <label className="label">
                <span className="inline-flex items-center gap-1.5">
                  <BookOpen className="w-3.5 h-3.5" />世界书
                </span>
              </label>
              <div className="space-y-0.5 mt-1 max-h-40 overflow-y-auto">
                {lorebooks.map(lb => (
                  <label
                    key={lb.id}
                    className={cn(
                      'flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs cursor-pointer transition-colors',
                      group.lorebookIds.includes(lb.id)
                        ? 'bg-tavern-accent-soft/50 text-tavern-accent'
                        : 'hover:bg-tavern-bg-hover text-tavern-text-muted'
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={group.lorebookIds.includes(lb.id)}
                      onChange={() => onToggleLorebook(lb.id)}
                      className="w-3.5 h-3.5 accent-tavern-accent rounded"
                    />
                    <span className="truncate">{lb.name}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* 预设 */}
          {presets.length > 0 && (
            <div>
              <label className="label">
                <span className="inline-flex items-center gap-1.5">
                  <FileText className="w-3.5 h-3.5" />预设
                </span>
              </label>
              <select
                value={group.presetId ?? ''}
                onChange={e => onSave({ ...group, presetId: e.target.value || null })}
                className="w-full mt-1 bg-tavern-bg border border-tavern-border-soft rounded-lg px-2.5 py-1.5 text-xs text-tavern-text outline-none focus:border-tavern-accent"
              >
                <option value="">无预设</option>
                {presets.map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
          )}

          {/* 对话模式 */}
          <div>
            <label className="label">对话模式</label>
            <div className="grid grid-cols-3 gap-1.5 mt-1">
              {([
                { key: 'mention' as const, label: '@点名', icon: AtSign },
                { key: 'polling' as const, label: '轮询', icon: Repeat },
                { key: 'free' as const, label: '自由', icon: Zap },
              ]).map(m => {
                const Icon = m.icon
                return (
                  <button
                    key={m.key}
                    onClick={() => onSave({ ...group, chatMode: m.key })}
                    className={cn(
                      'flex flex-col items-center gap-0.5 px-2 py-2 rounded-lg border text-xs transition-colors',
                      group.chatMode === m.key
                        ? 'border-tavern-accent bg-tavern-accent-soft text-tavern-accent'
                        : 'border-tavern-border-soft text-tavern-text-muted hover:border-tavern-border'
                    )}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    {m.label}
                  </button>
                )
              })}
            </div>
          </div>

          {/* polling 模式配置 */}
          {group.chatMode === 'polling' && (
            <>
              <div className="flex items-center justify-between">
                <label className="label">自动接力</label>
                <button
                  onClick={() => onSave({ ...group, autoMode: !group.autoMode })}
                  className={cn(
                    'px-3 py-1 rounded-lg text-xs font-medium transition-colors',
                    group.autoMode
                      ? 'bg-tavern-success/20 text-tavern-success'
                      : 'bg-tavern-bg-hover text-tavern-text-muted'
                  )}
                >
                  {group.autoMode ? <Zap className="w-3.5 h-3.5 inline mr-0.5" /> : <ZapOff className="w-3.5 h-3.5 inline mr-0.5" />}
                  {group.autoMode ? '开启' : '关闭'}
                </button>
              </div>

              <div>
                <label className="label">
                  最大轮数 <span className="text-xs text-tavern-text-muted ml-1">{group.maxRounds}</span>
                </label>
                <input
                  type="range"
                  min="1"
                  max="5"
                  step="1"
                  value={localMaxRounds}
                  onChange={e => setLocalMaxRounds(Number(e.target.value))}
                  onMouseUp={() => onSave({ ...group, maxRounds: localMaxRounds })}
                  onTouchEnd={() => onSave({ ...group, maxRounds: localMaxRounds })}
                  className="w-full accent-tavern-accent"
                />
              </div>

              <div>
                <label className="label">
                  发言间隔 <span className="text-xs text-tavern-text-muted ml-1">{group.speakerInterval}ms</span>
                </label>
                <input
                  type="range"
                  min="500"
                  max="5000"
                  step="500"
                  value={localSpeakerInterval}
                  onChange={e => setLocalSpeakerInterval(Number(e.target.value))}
                  onMouseUp={() => onSave({ ...group, speakerInterval: localSpeakerInterval })}
                  onTouchEnd={() => onSave({ ...group, speakerInterval: localSpeakerInterval })}
                  className="w-full accent-tavern-accent"
                />
              </div>
            </>
          )}

          {/* 自定义 System Prompt */}
          <div>
            <label className="label">自定义 System Prompt</label>
            <textarea
              value={localSystemPrompt}
              onChange={e => setLocalSystemPrompt(e.target.value)}
              onBlur={() => onSave({ ...group, systemPrompt: localSystemPrompt })}
              rows={4}
              placeholder="可选：为群聊添加上下文提示..."
              className="w-full bg-tavern-bg border border-tavern-border-soft rounded-lg px-2.5 py-1.5 text-xs text-tavern-text outline-none focus:border-tavern-accent resize-none placeholder:text-tavern-text-muted/50"
            />
          </div>

          {/* 导出 */}
          <div>
            <button onClick={onExport} className="w-full btn-secondary text-sm flex items-center justify-center gap-1.5">
              <Download className="w-3.5 h-3.5" />
              导出对话
            </button>
          </div>

          {/* 背景设置 */}
          <div>
            <label className="label">聊天背景</label>
            <div className="space-y-2 mt-1">
              {/* 不透明度 */}
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-tavern-text-muted w-10">不透明度</span>
                <input
                  type="range"
                  min="0"
                  max="100"
                  step="5"
                  value={Math.round(localOpacity * 100)}
                  onChange={e => setLocalOpacity(Number(e.target.value) / 100)}
                  onMouseUp={() => onSave({
                    ...group,
                    chatBackgroundParams: { ...group.chatBackgroundParams, opacity: localOpacity, type: group.chatBackgroundParams?.type ?? 'gradient', blur: localBlur },
                  })}
                  onTouchEnd={() => onSave({
                    ...group,
                    chatBackgroundParams: { ...group.chatBackgroundParams, opacity: localOpacity, type: group.chatBackgroundParams?.type ?? 'gradient', blur: localBlur },
                  })}
                  className="flex-1 accent-tavern-accent"
                />
                <span className="text-[10px] text-tavern-text-muted w-8 text-right">
                  {Math.round(localOpacity * 100)}%
                </span>
              </div>

              {/* 模糊度 */}
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-tavern-text-muted w-10">模糊</span>
                <input
                  type="range"
                  min="0"
                  max="20"
                  step="1"
                  value={localBlur}
                  onChange={e => setLocalBlur(Number(e.target.value))}
                  onMouseUp={() => onSave({
                    ...group,
                    chatBackgroundParams: { ...group.chatBackgroundParams, blur: localBlur, type: group.chatBackgroundParams?.type ?? 'gradient', opacity: localOpacity },
                  })}
                  onTouchEnd={() => onSave({
                    ...group,
                    chatBackgroundParams: { ...group.chatBackgroundParams, blur: localBlur, type: group.chatBackgroundParams?.type ?? 'gradient', opacity: localOpacity },
                  })}
                  className="flex-1 accent-tavern-accent"
                />
                <span className="text-[10px] text-tavern-text-muted w-8 text-right">{localBlur}px</span>
              </div>

              {/* 预设渐变 */}
              <div className="flex flex-wrap gap-1">
                {[
                  { name: '无', value: '' },
                  { name: '日落', value: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)' },
                  { name: '海洋', value: 'linear-gradient(135deg, #0c3483 0%, #a2b6df 100%)' },
                  { name: '樱花', value: 'linear-gradient(135deg, #f5af19 0%, #f12711 100%)' },
                  { name: '森林', value: 'linear-gradient(135deg, #11998e 0%, #38ef7d 100%)' },
                  { name: '暗夜', value: 'linear-gradient(135deg, #141e30 0%, #243b55 100%)' },
                ].map(g => (
                  <button
                    key={g.name}
                    onClick={() => onSave({
                      ...group,
                      chatBackgroundParams: {
                        ...group.chatBackgroundParams,
                        type: 'gradient',
                        gradient: g.value || undefined,
                        opacity: group.chatBackgroundParams?.opacity ?? 0.3,
                        blur: group.chatBackgroundParams?.blur ?? 0,
                      },
                    })}
                    className={cn(
                      'px-2 py-1 text-[10px] rounded border transition-colors',
                      (group.chatBackgroundParams?.gradient ?? '') === (g.value ?? '')
                        ? 'border-tavern-accent bg-tavern-accent-soft text-tavern-accent'
                        : 'border-tavern-border-soft text-tavern-text-muted hover:border-tavern-border'
                    )}
                  >
                    {g.name}
                  </button>
                ))}
              </div>

              {/* 自定义图片 */}
              <button
                onClick={async () => {
                  const path = await window.api.file.selectImage()
                  if (!path) return
                  const base64 = await window.api.file.readImageAsBase64(path)
                  onSave({
                    ...group,
                    chatBackground: base64,
                    chatBackgroundParams: {
                      ...group.chatBackgroundParams,
                      type: 'image',
                      opacity: group.chatBackgroundParams?.opacity ?? 0.6,
                      blur: group.chatBackgroundParams?.blur ?? 0,
                    },
                  })
                }}
                className="w-full btn-ghost text-xs py-1.5"
              >
                + 选择背景图片
              </button>
              {group.chatBackground && group.chatBackgroundParams?.type === 'image' && (
                <button
                  onClick={() => onSave({
                    ...group,
                    chatBackground: undefined,
                    chatBackgroundParams: {
                      ...group.chatBackgroundParams,
                      type: 'gradient',
                    },
                  })}
                  className="w-full btn-ghost text-xs py-1 text-tavern-danger"
                >
                  移除背景图片
                </button>
              )}
            </div>
          </div>

          {/* 气泡不透明度 */}
          <div>
            <label className="label">气泡不透明度</label>
            <div className="flex items-center gap-2 mt-1">
              <input
                type="range"
                min="0"
                max="100"
                step="5"
                value={Math.round(localInputOpacity * 100)}
                onChange={e => setLocalInputOpacity(Number(e.target.value) / 100)}
                onMouseUp={() => onSave({ ...group, bubbleOpacity: localInputOpacity })}
                onTouchEnd={() => onSave({ ...group, bubbleOpacity: localInputOpacity })}
                className="flex-1 accent-tavern-accent"
              />
              <span className="text-[10px] text-tavern-text-muted w-8 text-right">
                {Math.round(localInputOpacity * 100)}%
              </span>
            </div>
          </div>

          {/* 主题色 */}
          <div>
            <label className="label">
              <span className="inline-flex items-center gap-1.5">
                <Palette className="w-3.5 h-3.5" />主题色
              </span>
            </label>
            <div className="flex items-center gap-2 mt-1">
              <input
                type="color"
                value={group.themeColor || '#6366f1'}
                onChange={e => onSave({ ...group, themeColor: e.target.value || undefined })}
                className="w-8 h-8 rounded cursor-pointer border-0 p-0 bg-transparent"
              />
              <span className="text-xs text-tavern-text-muted">
                {group.themeColor || '默认'}
              </span>
              {group.themeColor && (
                <button
                  onClick={() => onSave({ ...group, themeColor: undefined })}
                  className="text-[10px] text-tavern-text-muted hover:text-tavern-text"
                >
                  重置
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-1.5 mt-2">
              {['#6366f1', '#ec4899', '#14b8a6', '#f59e0b', '#8b5cf6', '#06b6d4', '#ef4444', '#84cc16'].map(c => (
                <button
                  key={c}
                  onClick={() => onSave({ ...group, themeColor: c })}
                  className={cn(
                    'w-6 h-6 rounded-full border-2 transition-all',
                    group.themeColor === c
                      ? 'border-white scale-110 shadow-md'
                      : 'border-transparent hover:scale-110'
                  )}
                  style={{ backgroundColor: c }}
                  title={c}
                />
              ))}
            </div>
          </div>

          {/* 删除群聊 */}
          <div className="pt-2 border-t border-tavern-border-soft">
            <button
              onClick={() => { onClose(); onDelete() }}
              className="w-full btn-ghost text-sm text-tavern-danger py-2"
            >
              删除群聊
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
