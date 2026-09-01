/**
 * 世界书条目编辑弹窗（P-8 从 LorebookPage 拆分）
 */
import { Loader2, Languages, X } from 'lucide-react'
import type { Lorebook, LoreEntry } from '../../../shared/types'
import { Modal } from '../../components/common/Modal'
import { POSITION_LABELS, MATCH_MODE_LABELS, PRIORITY_LABELS } from './lorebookConstants'
import { Toggle } from './lorebookComponents'
import { LorebookEntryTriggerTester } from './LorebookEntryTriggerTester'

interface LorebookEntryEditorProps {
  editingEntry: LoreEntry
  lorebook: Lorebook
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
  lorebook,
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
    <Modal
      open
      onClose={onCancel}
      title={isNew ? '新建世界书条目' : '编辑世界书条目'}
      width="custom"
      widthClassName="max-w-5xl"
      contentClassName="bg-tavern-bg-soft/35"
      footer={
        <>
          <button className="btn-secondary" onClick={onCancel}>
            取消
          </button>
          <button className="btn-primary" onClick={onSave}>
            保存条目
          </button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="lg:col-span-2">
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
        <div className="lg:col-span-2">
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
        <div className="lg:col-span-2">
          <label className="label">摘要（可选）</label>
          <textarea
            className="textarea h-16"
            placeholder="预算紧张时以此代替全文注入..."
            value={editingEntry.summary ?? ''}
            onChange={(e) =>
              setEditingEntry({
                ...editingEntry,
                summary: e.target.value.trim() ? e.target.value : undefined,
              })
            }
          />
          <p className="text-xs text-tavern-text-muted mt-1">
            世界书预算不足时，优先用这段摘要代替全文注入，避免条目被直接丢弃；留空则由 AI 压缩兜底。
          </p>
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
          <label className="label">优先级</label>
          <select
            className="select"
            value={editingEntry.priority ?? 'conditional'}
            onChange={(e) =>
              setEditingEntry({
                ...editingEntry,
                priority: e.target.value as NonNullable<LoreEntry['priority']>,
              })
            }
          >
            <option value="always">{PRIORITY_LABELS.always}（无条件注入）</option>
            <option value="conditional">{PRIORITY_LABELS.conditional}（命中时注入）</option>
            <option value="detail">{PRIORITY_LABELS.detail}（仅用剩余预算）</option>
          </select>
          <p className="text-xs text-tavern-text-muted mt-1">
            {editingEntry.priority === 'always'
              ? '常驻条目无需关键词即每轮注入；内容仍会参与其他条目的递归触发。'
              : editingEntry.priority === 'detail'
                ? '细节条目在常驻与条件条目装满预算后，仅用剩余额度注入。'
                : '关键词或语义命中时注入（默认，与其他条目共享预算）。'}
          </p>
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
              ? '仅通过语义相似度触发：不依赖关键词，但需要先生成索引并在「模型 → 语义检索」中配置向量来源。'
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
        <div className="lg:col-span-2">
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
        <div className="flex items-center gap-2 lg:col-span-2">
          <span className="text-sm text-tavern-text-soft">启用此条目</span>
          <Toggle
            checked={editingEntry.enabled}
            onChange={(v) => setEditingEntry({ ...editingEntry, enabled: v })}
          />
        </div>
        <LorebookEntryTriggerTester lorebook={lorebook} entry={editingEntry} />
      </div>
    </Modal>
  )
}
