/**
 * MCP 工具调用测试面板（P-8 从 McpPage 拆分）
 */
import { Wrench, X, Loader2, Play } from 'lucide-react'
import type { McpServerConfig, McpTool } from './mcpTypes'

interface McpTestPanelProps {
  tools: McpTool[]
  servers: McpServerConfig[]
  testTool: string
  setTestTool: (v: string) => void
  testArgs: string
  setTestArgs: (v: string) => void
  testResult: string | null
  testError: string | null
  testing: boolean
  onCall: () => void
  onClose: () => void
}

export function McpTestPanel({
  tools,
  servers,
  testTool,
  setTestTool,
  testArgs,
  setTestArgs,
  testResult,
  testError,
  testing,
  onCall,
  onClose,
}: McpTestPanelProps) {
  const selectedTool = testTool ? tools.find((t) => t.name === testTool) : undefined

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-tavern-bg-soft rounded-xl border border-tavern-border-soft w-full max-w-lg mx-4 max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-tavern-border-soft">
          <h3 className="text-sm font-medium flex items-center gap-2">
            <Wrench className="w-4 h-4 text-tavern-accent" />
            工具调用测试
          </h3>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-tavern-bg-hover text-tavern-text-muted"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-4 space-y-3">
          {/* 选择工具 */}
          <div>
            <label className="label">选择工具</label>
            <select
              className="input text-sm"
              value={testTool}
              onChange={(e) => setTestTool(e.target.value)}
            >
              {tools.length === 0 && <option value="">无可用工具</option>}
              {tools.map((t) => {
                const srv = servers.find((s) => s.id === t.serverId)
                return (
                  <option key={`${t.serverId}/${t.name}`} value={t.name}>
                    {srv?.name ?? t.serverId} / {t.name}
                  </option>
                )
              })}
            </select>
          </div>

          {/* 选中工具的参数 schema 提示 */}
          {selectedTool?.inputSchema?.properties &&
            Object.keys(selectedTool.inputSchema.properties).length > 0 && (
              <div className="text-xs bg-tavern-bg rounded-lg p-2.5 border border-tavern-border-soft space-y-1">
                <div className="text-tavern-text-muted mb-1">参数：</div>
                {Object.entries(selectedTool.inputSchema.properties).map(([key, prop]) => (
                  <div key={key} className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-tavern-accent">{key}</span>
                    <span className="text-tavern-text-muted">{prop.type}</span>
                    {selectedTool.inputSchema.required?.includes(key) && (
                      <span className="text-tavern-danger">*</span>
                    )}
                    {prop.description && (
                      <span className="text-tavern-text-soft">{prop.description}</span>
                    )}
                  </div>
                ))}
              </div>
            )}

          {/* JSON 参数输入 */}
          <div>
            <label className="label">参数 (JSON)</label>
            <textarea
              className="textarea text-xs font-mono min-h-[100px]"
              value={testArgs}
              onChange={(e) => setTestArgs(e.target.value)}
              placeholder='{"key": "value"}'
            />
          </div>

          <button
            onClick={onCall}
            disabled={testing || !testTool}
            className="btn-primary text-sm flex items-center gap-1.5"
          >
            {testing ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Play className="w-3.5 h-3.5" />
            )}
            调用
          </button>

          {/* 错误 */}
          {testError && (
            <p className="text-xs text-tavern-danger bg-tavern-danger/5 rounded px-2 py-1.5 break-all">
              {testError}
            </p>
          )}

          {/* 结果 */}
          {testResult !== null && (
            <div>
              <div className="text-xs text-tavern-text-muted mb-1">结果：</div>
              <pre className="text-xs font-mono text-tavern-text-soft bg-tavern-bg rounded-lg p-2.5 border border-tavern-border-soft whitespace-pre-wrap break-all max-h-60 overflow-y-auto">
                {testResult}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
