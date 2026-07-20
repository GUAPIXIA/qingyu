import { useEffect, useState } from 'react'
import { Modal } from '../components/common/Modal'
import { EmptyState } from '../components/common/EmptyState'
import { ConfirmDialog } from '../components/common/ConfirmDialog'
import { cn } from '../lib/utils'
import { Regex as RegexIcon, Plus, Trash2, Pencil, Play } from 'lucide-react'
import type { RegexRule } from '../../shared/types'

export function RegexPage() {
  const [rules, setRules] = useState<RegexRule[]>([])
  const [editing, setEditing] = useState<RegexRule | null>(null)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [testInput, setTestInput] = useState('')
  const [testOutput, setTestOutput] = useState('')

  const loadRules = () => {
    window.api.regex.list().then(setRules)
  }

  useEffect(() => {
    loadRules()
  }, [])

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

  const handleTest = () => {
    if (!editing || !testInput) {
      setTestOutput(testInput)
      return
    }
    try {
      const regex = new RegExp(editing.pattern, 'g')
      setTestOutput(testInput.replace(regex, editing.replacement))
    } catch {
      setTestOutput('正则语法错误')
    }
  }

  const scopeLabels = { input: '输入', output: '输出', both: '输入+输出' }

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
            description="创建正则规则来自动处理输入或输出的文本"
          />
        ) : (
          <div className="max-w-3xl mx-auto space-y-3">
            {rules.map((rule) => (
              <div key={rule.id} className="card p-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className={cn('w-2 h-2 rounded-full', rule.enabled ? 'bg-tavern-accent' : 'bg-tavern-text-muted')} />
                    <span className="font-medium">{rule.name}</span>
                    <span className="px-1.5 py-0.5 rounded text-xs bg-tavern-bg-hover text-tavern-text-muted">
                      {scopeLabels[rule.scope]}
                    </span>
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
                  <span className="text-tavern-text-soft">/{rule.pattern || '...'}/g</span>
                  <span className="text-tavern-accent mx-2">→</span>
                  <span className="text-tavern-text-soft">"{rule.replacement}"</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 编辑 Modal */}
      <Modal open={!!editing} onClose={() => setEditing(null)} title="编辑正则规则" width="xl">
        {editing && (
          <div className="space-y-4">
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

            {/* 测试区 */}
            <div className="border-t border-tavern-border-soft pt-4">
              <label className="label flex items-center gap-1.5">
                <Play className="w-3.5 h-3.5" />
                测试
              </label>
              <textarea
                className="textarea mb-2"
                rows={2}
                value={testInput}
                onChange={(e) => setTestInput(e.target.value)}
                placeholder="输入测试文本..."
              />
              <button onClick={handleTest} className="btn-secondary text-sm mb-2">运行测试</button>
              {testOutput && (
                <div className="p-2 rounded-lg bg-tavern-bg-soft text-sm text-tavern-text-soft font-mono whitespace-pre-wrap">
                  {testOutput}
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
