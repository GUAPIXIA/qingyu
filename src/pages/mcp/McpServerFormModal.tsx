/**
 * MCP Server 添加/编辑弹窗（P-8 从 McpPage 拆分）
 */
import { Server, X } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { ServerForm } from './mcpTypes'

interface McpServerFormModalProps {
  editingId: string | null
  form: ServerForm
  setForm: (fn: (f: ServerForm) => ServerForm) => void
  onSave: () => void
  onClose: () => void
}

export function McpServerFormModal({ editingId, form, setForm, onSave, onClose }: McpServerFormModalProps) {
  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-tavern-bg-soft rounded-xl border border-tavern-border-soft w-full max-w-md mx-4 max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-tavern-border-soft">
          <h3 className="text-sm font-medium flex items-center gap-2">
            <Server className="w-4 h-4 text-tavern-accent" />
            {editingId ? '编辑 Server' : '添加 Server'}
          </h3>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-tavern-bg-hover text-tavern-text-muted"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-4 space-y-3">
          {/* 名称 */}
          <div>
            <label className="label">名称</label>
            <input
              type="text"
              className="input text-sm"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="如：filesystem"
              autoFocus
            />
          </div>

          {/* 传输方式 */}
          <div>
            <label className="label">传输方式</label>
            <div className="flex gap-1.5">
              {(['stdio', 'sse'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setForm((f) => ({ ...f, transport: t }))}
                  className={cn(
                    'px-3 py-1 rounded text-xs border transition-colors',
                    form.transport === t
                      ? 'border-tavern-accent bg-tavern-accent-soft text-tavern-accent'
                      : 'border-tavern-border-soft bg-tavern-bg-soft text-tavern-text-soft hover:border-tavern-border'
                  )}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          {/* stdio 模式字段 */}
          {form.transport === 'stdio' ? (
            <>
              <div>
                <label className="label">命令 (command)</label>
                <input
                  type="text"
                  className="input text-sm font-mono"
                  value={form.command}
                  onChange={(e) => setForm((f) => ({ ...f, command: e.target.value }))}
                  placeholder="如：npx"
                />
              </div>
              <div>
                <label className="label">参数 (逗号分隔)</label>
                <input
                  type="text"
                  className="input text-sm font-mono"
                  value={form.args}
                  onChange={(e) => setForm((f) => ({ ...f, args: e.target.value }))}
                  placeholder="如：-y, @modelcontextprotocol/server-filesystem, /tmp"
                />
              </div>
              <div>
                <label className="label">环境变量 (每行 KEY=value)</label>
                <textarea
                  className="textarea text-xs font-mono min-h-[80px]"
                  value={form.env}
                  onChange={(e) => setForm((f) => ({ ...f, env: e.target.value }))}
                  placeholder={'API_KEY=xxx\nDEBUG=true'}
                />
              </div>
            </>
          ) : (
            <div>
              <label className="label">URL</label>
              <input
                type="text"
                className="input text-sm font-mono"
                value={form.url}
                onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
                placeholder="https://example.com/sse"
              />
            </div>
          )}

          {/* 自动启动 */}
          <label className="flex items-center gap-2 cursor-pointer text-sm text-tavern-text-soft">
            <input
              type="checkbox"
              checked={form.autoStart}
              onChange={(e) => setForm((f) => ({ ...f, autoStart: e.target.checked }))}
              className="rounded"
            />
            自动启动
          </label>
        </div>
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-tavern-border-soft">
          <button onClick={onClose} className="btn-ghost text-sm">
            取消
          </button>
          <button
            onClick={onSave}
            disabled={!form.name.trim()}
            className="btn-primary text-sm"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
