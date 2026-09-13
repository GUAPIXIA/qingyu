/**
 * MCP Server 添加/编辑弹窗（P-8 从 McpPage 拆分）。
 *
 * P1-03：改用通用 Modal 组件（role=dialog / aria-modal / Esc 关闭 / 焦点圈定），不再自建遮罩。
 */
import { cn } from '../../lib/utils'
import { Modal } from '../../components/common/Modal'
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
    <Modal
      open
      onClose={onClose}
      title={editingId ? '编辑 Server' : '添加 Server'}
      width="md"
      footer={
        <>
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
        </>
      }
    >
      <div className="space-y-3">
        {/* 名称 */}
        <div>
          <label className="label" htmlFor="mcp-server-name">名称</label>
          <input
            id="mcp-server-name"
            type="text"
            className="input text-sm"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="如：filesystem"
          />
        </div>

        {/* 传输方式 - H0: SSE 暂未实现，禁用并提示 */}
        <div>
          <span className="label">传输方式</span>
          <div className="flex gap-1.5" role="group" aria-label="传输方式">
            {(['stdio', 'sse'] as const).map((t) => {
              const isSSE = t === 'sse'
              return (
                <button
                  key={t}
                  disabled={isSSE}
                  aria-pressed={form.transport === t}
                  title={isSSE ? 'SSE 传输暂未实现，敬请期待' : undefined}
                  onClick={() => !isSSE && setForm((f) => ({ ...f, transport: t }))}
                  className={cn(
                    'px-3 py-1 rounded text-xs border transition-colors',
                    form.transport === t
                      ? 'border-tavern-accent bg-tavern-accent-soft text-tavern-accent'
                      : 'border-tavern-border-soft bg-tavern-bg-soft text-tavern-text-soft hover:border-tavern-border',
                    isSSE && 'opacity-50 cursor-not-allowed'
                  )}
                >
                  {t}{isSSE && ' (暂未支持)'}
                </button>
              )
            })}
          </div>
          <p className="mt-1 text-[11px] text-tavern-text-muted">SSE 传输后端暂未实现，选择后将无法连接，已暂时禁用。</p>
        </div>

        {/* stdio 模式字段 */}
        {form.transport === 'stdio' ? (
          <>
            <div>
              <label className="label" htmlFor="mcp-server-command">命令 (command)</label>
              <input
                id="mcp-server-command"
                type="text"
                className="input text-sm font-mono"
                value={form.command}
                onChange={(e) => setForm((f) => ({ ...f, command: e.target.value }))}
                placeholder="如：npx"
              />
            </div>
            <div>
              <label className="label" htmlFor="mcp-server-args">参数 (逗号分隔)</label>
              <input
                id="mcp-server-args"
                type="text"
                className="input text-sm font-mono"
                value={form.args}
                onChange={(e) => setForm((f) => ({ ...f, args: e.target.value }))}
                placeholder="如：-y, @modelcontextprotocol/server-filesystem, /tmp"
              />
            </div>
            <div>
              <label className="label" htmlFor="mcp-server-env">环境变量 (每行 KEY=value)</label>
              <textarea
                id="mcp-server-env"
                className="textarea text-xs font-mono min-h-[80px]"
                value={form.env}
                onChange={(e) => setForm((f) => ({ ...f, env: e.target.value }))}
                placeholder={'API_KEY=xxx\nDEBUG=true'}
              />
            </div>
          </>
        ) : (
          <div>
            <label className="label" htmlFor="mcp-server-url">URL</label>
            <input
              id="mcp-server-url"
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
    </Modal>
  )
}
