import { useEffect, useMemo, useState } from 'react'
import { Modal } from '../components/common/Modal'
import { EmptyState } from '../components/common/EmptyState'
import { ConfirmDialog } from '../components/common/ConfirmDialog'
import { cn } from '../lib/utils'
import { Regex as RegexIcon, Plus, Trash2, Pencil, Play, ChevronDown, ChevronRight } from 'lucide-react'
import type { RegexRule } from '../../shared/types'
import { applyRegexRules } from '../utils/regex'

const scopeLabels: Record<RegexRule['scope'], string> = { input: '输入', output: '输出', both: '输入+输出' }
const stageLabels: Record<NonNullable<RegexRule['stage']>, string> = {
  text: '文本',
  markdown: 'Markdown',
}

/** 规则分组键：空 group 归入「未分组」 */
function groupKey(rule: RegexRule): string {
  return rule.group?.trim() || '未分组'
}

export function RegexPage() {
  const [rules, setRules] = useState<RegexRule[]>([])
  const [editing, setEditing] = useState<RegexRule | null>(null)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  // 预览测试
  const [testScope, setTestScope] = useState<'input' | 'output'>('output')
  const [testInput, setTestInput] = useState('')
  const [testOutput, setTestOutput] = useState<{ text: string; applied: number; matched: number } | null>(null)

  const loadRules = () => {
    window.api.regex.list().then(setRules)
  }

  useEffect(() => {
    loadRules()
  }, [])

  /** 按分组聚合（保留组出现顺序） */
  const grouped = useMemo(() => {
    const map = new Map<string, RegexRule[]>()
    for (const rule of rules) {
      const key = groupKey(rule)
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(rule)
    }
    return [...map.entries()]
  }, [rules])

  const handleNew = async () => {
    const rule = await window.api.regex.create('新规则')
    setEditing(rule)
    loadRules()
  }

  const handleSave = async () => {
    if (!editing) return
    await window.api.regex.save(editing)
    setEditing(null)
    loadRules()
  }

  const handleDelete = async () => {
    if (!deleteId) return
    await window.api.regex.delete(deleteId)
    setDeleteId(null)
    loadRules()
  }

  /** 全链路预览测试：按 scope + 两阶段应用所有启用规则 */
  const handleTest = () => {
    if (!editing) return
    if (!testInput) {
      setTestOutput({ text: '', applied: 0, matched: 0 })
      return
    }
    try {
      const result = applyRegexRules(testInput, rules.filter(r => r.enabled), testScope, 'text')
      const markdown = testScope === 'output'
        ? applyRegexRules(result.text, rules.filter(r => r.enabled), 'output', 'markdown')
        : result
      setTestOutput({ text: markdown.text, applied: result.applied + (testScope === 'output' ? markdown.applied : 0), matched: result.matched + (testScope === 'output' ? markdown.matched : 0) })
    } catch {
      setTestOutput({ text: '正则执行错误', applied: 0, matched: 0 })
    }
  }

  /** 单规则即时测试（编辑区内） */
  const handleSingleTest = () => {
    if (!editing) return
    try {
      const regex = new RegExp(editing.pattern, editing.flags || 'g')
      setTestOutput({ text: testInput.replace(regex, editing.replacement), applied: 1, matched: 1 })
    } catch {
      setTestOutput({ text: '正则语法错误', applied: 0, matched: 0 })
    }
  }

  const toggleGroup = (key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <header className="flex items-center justify-between px-4 h-14 border-b border-tavern-border-soft bg-tavern-bg-soft shrink-0">
        <h1 className="font-display text-lg font-bold">正则表达式</h1>
        <button onClick={handleNew} className="btn-primary">
          <Plus className="w-4 h-4" />
          新建规则
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-4">
        {rules.length === 0 ? (
          <EmptyState
            icon={<RegexIcon className="w-8 h-8" />}
            title="暂无正则规则"
            description="创建正则规则来自动处理输入或输出的文本，支持分组管理与预览测试"
          />
        ) : (
          <div className="max-w-3xl mx-auto space-y-4">
            {grouped.map(([group, groupRules]) => {
              const collapsed = collapsedGroups.has(group)
              const enabledCount = groupRules.filter(r => r.enabled).length
              return (
                <div key={group} className="space-y-2">
                  <button
                    onClick={() => toggleGroup(group)}
                    className="flex items-center gap-1.5 text-sm font-medium text-tavern-text-muted hover:text-tavern-text w-full"
                  >
                    {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    <span>{group}</span>
                    <span className="text-xs text-tavern-text-muted/60">（{groupRules.length} 条{groupRules.length !== enabledCount ? `，启用 ${enabledCount}` : ''}）</span>
                  </button>
                  {!collapsed && (
                    <div className="space-y-2">
                      {groupRules.map((rule) => (
                        <div key={rule.id} className="card p-4">
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2">
                              <span className={cn('w-2 h-2 rounded-full', rule.enabled ? 'bg-tavern-accent' : 'bg-tavern-text-muted')} />
                              <span className="font-medium">{rule.name}</span>
                              <span className="px-1.5 py-0.5 rounded text-xs bg-tavern-bg-hover text-tavern-text-muted">
                                {scopeLabels[rule.scope]}
                              </span>
                              <span className="px-1.5 py-0.5 rounded text-xs bg-tavern-bg-hover text-tavern-text-muted">
                                {stageLabels[rule.stage ?? 'text']}
                              </span>
                              {rule.triggerPattern && (
                                <span className="px-1.5 py-0.5 rounded text-xs bg-tavern-accent-soft text-tavern-accent" title={`仅当文本匹配 ${rule.triggerPattern} 时执行`}>
                                  触发
                                </span>
                              )}
                              {rule.stopStrings && rule.stopStrings.length > 0 && (
                                <span className="px-1.5 py-0.5 rounded text-xs bg-tavern-bg-hover text-tavern-text-muted" title="输出命中后终止生成">
                                  停止
                                </span>
                              )}
                            </div>
                            <div className="flex gap-1">
                              <button
                                onClick={() => setEditing({ ...rule })}
                                className="p-1.5 rounded text-tavern-text-muted hover:text-tavern-text hover:bg-tavern-bg-hover"
                              >
                                <Pencil className="w-4 h-4" />
                              </button>
                              <button
                                onClick={() => setDeleteId(rule.id)}
                                className="p-1.5 rounded text-tavern-text-muted hover:text-tavern-danger hover:bg-tavern-bg-hover"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          </div>
                          <div className="text-sm text-tavern-text-muted font-mono">
                            <span className="text-tavern-text-soft">/{rule.pattern || '...'}/{rule.flags || 'g'}</span>
                            <span className="text-tavern-accent mx-2">→</span>
                            <span className="text-tavern-text-soft">"{rule.replacement}"</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* 编辑 Modal */}
      <Modal open={!!editing} onClose={() => setEditing(null)} title="编辑正则规则" width="xl">
        {editing && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">规则名称</label>
                <input
                  type="text"
                  className="input"
                  value={editing.name}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                />
              </div>
              <div>
                <label className="label">分组</label>
                <div className="flex gap-1.5">
                  <input
                    type="text"
                    className="input flex-1"
                    list="regex-groups"
                    value={editing.group ?? ''}
                    onChange={(e) => setEditing({ ...editing, group: e.target.value })}
                    placeholder="如：翻译修复 / 格式清理 / 越狱清理"
                  />
                  <datalist id="regex-groups">
                    {grouped.map(([g]) => <option key={g} value={g} />)}
                  </datalist>
                </div>
              </div>
            </div>

            <div>
              <label className="label">正则表达式（模式）</label>
              <input
                type="text"
                className="input font-mono"
                value={editing.pattern}
                onChange={(e) => setEditing({ ...editing, pattern: e.target.value })}
                placeholder="例如：\\[Status:.*?\\]"
              />
            </div>
            <div>
              <label className="label">替换文本</label>
              <input
                type="text"
                className="input font-mono"
                value={editing.replacement}
                onChange={(e) => setEditing({ ...editing, replacement: e.target.value })}
                placeholder="留空则删除匹配内容"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">正则标志</label>
                <input
                  type="text"
                  className="input font-mono"
                  value={editing.flags ?? 'g'}
                  onChange={(e) => setEditing({ ...editing, flags: e.target.value })}
                  placeholder="g (全局), i (忽略大小写), m (多行), s (dotAll)"
                />
              </div>
              <div>
                <label className="label">作用范围</label>
                <div className="flex gap-2">
                  {(['input', 'output', 'both'] as const).map((scope) => (
                    <button
                      key={scope}
                      onClick={() => setEditing({ ...editing, scope })}
                      className={cn(
                        'px-3 py-1.5 rounded-lg text-sm transition-colors',
                        editing.scope === scope
                          ? 'bg-tavern-accent text-tavern-bg'
                          : 'bg-tavern-bg-hover text-tavern-text-muted hover:text-tavern-text'
                      )}
                    >
                      {scopeLabels[scope]}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">处理阶段</label>
                <div className="flex gap-2">
                  {(['text', 'markdown'] as const).map((stage) => (
                    <button
                      key={stage}
                      onClick={() => setEditing({ ...editing, stage })}
                      className={cn(
                        'px-3 py-1.5 rounded-lg text-sm transition-colors',
                        (editing.stage ?? 'text') === stage
                          ? 'bg-tavern-accent text-tavern-bg'
                          : 'bg-tavern-bg-hover text-tavern-text-muted hover:text-tavern-text'
                      )}
                    >
                      {stageLabels[stage]}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-tavern-text-muted mt-1">
                  {editing.stage === 'markdown' ? 'Markdown 阶段：仅对输出生效，在文本规则之后链式应用（渲染层修复）' : '文本阶段：对输入/输出文本直接应用'}
                </p>
              </div>
              <div>
                <label className="label">触发器（匹配才执行）</label>
                <input
                  type="text"
                  className="input font-mono"
                  value={editing.triggerPattern ?? ''}
                  onChange={(e) => setEditing({ ...editing, triggerPattern: e.target.value })}
                  placeholder="留空 = 总是执行；如：\\*\\*（含粗体才处理）"
                />
                <input
                  type="text"
                  className="input font-mono mt-1.5"
                  value={editing.triggerFlags ?? 'i'}
                  onChange={(e) => setEditing({ ...editing, triggerFlags: e.target.value })}
                  placeholder="触发标志（默认 i）"
                />
              </div>
            </div>

            <div>
              <label className="label">停止字符串（逗号分隔，输出命中后终止生成）</label>
              <input
                type="text"
                className="input font-mono"
                value={(editing.stopStrings ?? []).join(',')}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    stopStrings: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                  })
                }
                placeholder="如：<|endoftext|>,【END】"
              />
              <p className="text-xs text-tavern-text-muted mt-1">流式生成中命中立即停止并截断，同时作为输出后处理兜底</p>
            </div>

            <div className="flex items-center gap-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={editing.enabled}
                  onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })}
                  className="accent-tavern-accent"
                />
                <span className="text-sm">启用</span>
              </label>
            </div>

            {/* 预览测试 */}
            <div className="border-t border-tavern-border-soft pt-4 space-y-2">
              <div className="flex items-center justify-between">
                <label className="label flex items-center gap-1.5">
                  <Play className="w-3.5 h-3.5" />
                  预览测试
                </label>
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-tavern-text-muted">范围</span>
                  <select
                    className="input text-xs py-1 px-2 w-24"
                    value={testScope}
                    onChange={(e) => setTestScope(e.target.value as 'input' | 'output')}
                  >
                    <option value="input">输入</option>
                    <option value="output">输出</option>
                  </select>
                </div>
              </div>
              <textarea
                className="textarea"
                rows={3}
                value={testInput}
                onChange={(e) => setTestInput(e.target.value)}
                placeholder="输入测试文本..."
              />
              <div className="flex gap-2">
                <button onClick={handleTest} className="btn-secondary text-sm">全规则运行</button>
                <button onClick={handleSingleTest} className="btn-ghost text-sm" disabled={!editing.pattern}>
                  仅当前规则
                </button>
              </div>
              {testOutput && (
                <div>
                  <div className="text-xs text-tavern-text-muted mb-1">
                    应用 {testOutput.applied} 条规则，命中替换 {testOutput.matched} 条
                  </div>
                  <div className="p-2 rounded-lg bg-tavern-bg-soft text-sm text-tavern-text-soft font-mono whitespace-pre-wrap max-h-48 overflow-y-auto">
                    {testOutput.text || '（空结果）'}
                  </div>
                </div>
              )}
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
        title="删除规则"
        message="确定要删除这条正则规则吗？"
        confirmText="删除"
        danger
      />
    </div>
  )
}
