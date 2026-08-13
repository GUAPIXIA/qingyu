/**
 * 世界书条目编辑表单（P-8 从 LorebookPage 拆分）
 */
import { Pencil, Loader2, Languages, X } from 'lucide-react'
import type { LoreEntry } from '../../../shared/types'
import { POSITION_LABELS, MATCH_MODE_LABELS } from './lorebookConstants'
import { Toggle } from './lorebookComponents'

interface LorebookEntryEditorProps {
  editingEntry: LoreEntry
  isNew: boolean
  setEditingEntry: (entry: LoreEntry) => void
  translatingField: { key: string; text: string } | null
  translateResult: string | null
  translateError: string | null
  onTranslate: (text: string, key: string, apply: (translated: string) => void) => void
  onSave: () => void
  onCancel: () => void
}

export function LorebookEntryEditor({
  editingEntry,
  isNew,
  setEditingEntry,
  translatingField,
  translateResult,
  translateError,
  onTranslate,
  onSave,
  onCancel,
}: LorebookEntryEditorProps) {
  return (
    <div className="border-t border-tavern-border-soft bg-tavern-bg-soft p-4 space-y-3 shrink-0 max-h-[55%] overflow-y-auto">
      <div className="flex items-center justify-between">
        <h3 className="font-medium text-sm text-tavern-text flex items-center gap-1.5">
          <Pencil className="w-3.5 h-3.5" />
          {isNew ? '新建条目' : '编辑条目'}
        </h3>
        <div className="flex items-center gap-2">
          <button className="btn-ghost" onClick={onCancel}>
            取消
          </button>
          <button className="btn-primary" onClick={onSave}>
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
          <div className="flex gap-1.5 items-start">
            <textarea
              className="textarea h-24 flex-1"
              placeholder="当关键词被触发时插入的内容..."
              value={editingEntry.content}
              onChange={(e) =>
                setEditingEntry({ ...editingEntry, content: e.target.value })
              }
            />
            <button
              className="btn-ghost p-1.5 shrink-0"
              title="AI 翻译内容"
              disabled={!!translatingField || !editingEntry.content}
              onClick={() => onTranslate(editingEntry.content, `edit-${editingEntry.id}`, (translated) => {
                setEditingEntry({ ...editingEntry, translation: translated })
              })}
            >
              {translatingField?.key === `edit-${editingEntry.id}` ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Languages className="w-3.5 h-3.5" />
              )}
            </button>
          </div>
          {/* 翻译流式预览 */}
          {translatingField?.key === `edit-${editingEntry.id}` && translateResult !== null && (
            <div className="mt-1.5 p-2 rounded bg-tavern-bg-hover border border-tavern-border-soft text-xs text-tavern-text-soft max-h-24 overflow-y-auto">
              {translateResult || '...'}
            </div>
          )}
          {/* 翻译错误提示（编辑弹窗） */}
          {translateError && translatingField?.key !== `edit-${editingEntry.id}` && !editingEntry.translation && (
            <div className="mt-1.5 text-xs text-tavern-danger">{translateError}</div>
          )}
          {/* 已有翻译结果展示 */}
          {editingEntry.translation && translatingField?.key !== `edit-${editingEntry.id}` && (
            <div className="mt-1.5 flex items-start gap-2 p-2 rounded bg-tavern-bg-hover border border-tavern-border-soft">
              <div className="flex-1 min-w-0">
                <span className="text-xs text-tavern-accent font-medium">翻译结果：</span>
                <p className="text-xs text-tavern-text-soft mt-0.5 whitespace-pre-wrap">
                  {editingEntry.translation}
                </p>
              </div>
              <button
                className="btn-ghost p-0.5 shrink-0 text-tavern-text-muted hover:text-tavern-danger"
                title="清除翻译"
                onClick={() => setEditingEntry({ ...editingEntry, translation: undefined })}
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
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
            <option value="at_depth">{POSITION_LABELS.at_depth}</option>
            <option value="at_end">{POSITION_LABELS.at_end}</option>
          </select>
        </div>
        <div>
          <label className="label">匹配模式</label>
          <select
            className="select"
            value={editingEntry.matchMode ?? 'both'}
            onChange={(e) =>
              setEditingEntry({
                ...editingEntry,
                matchMode: e.target.value as NonNullable<LoreEntry['matchMode']>,
              })
            }
          >
            <option value="keyword">{MATCH_MODE_LABELS.keyword}（仅关键词/正则）</option>
            <option value="semantic">{MATCH_MODE_LABELS.semantic}（需先生成语义索引）</option>
            <option value="both">{MATCH_MODE_LABELS.both}</option>
          </select>
          <p className="text-xs text-tavern-text-muted mt-1">
            {editingEntry.matchMode === 'semantic'
              ? '仅通过语义相似度触发：不依赖关键词，但需要先生成索引并启用「设置 → 语义触发」。'
              : editingEntry.matchMode === 'both'
                ? '关键词命中或语义相似（"猫娘"可触发含"猫咪"的条目）均可触发。'
                : '仅按关键词/正则匹配触发。'}
          </p>
        </div>
        {editingEntry.position === 'at_depth' && (
          <div>
            <label className="label">注入深度（0 = 最新消息后）</label>
            <input
              type="number"
              min={0}
              className="input"
              value={editingEntry.depth ?? 0}
              onChange={(e) =>
                setEditingEntry({
                  ...editingEntry,
                  depth: Math.max(0, Number(e.target.value) || 0),
                })
              }
            />
          </div>
        )}
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
  )
}
