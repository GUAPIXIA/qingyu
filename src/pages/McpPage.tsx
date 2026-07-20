import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { cn } from '../lib/utils'
import {
  ArrowLeft,
  Plus,
  Play,
  Square,
  Pencil,
  Trash2,
  ChevronDown,
  ChevronRight,
  Wrench,
  Server,
  Circle,
  Loader2,
  X,
  Terminal,
  Globe,
} from 'lucide-react'

/** MCP Server 配置 */
interface McpServerConfig {
  id: string
  name: string
  transport: 'stdio' | 'sse'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  enabled: boolean
  autoStart: boolean
}

/** MCP Server 运行状态 */
interface McpServerStatus {
  id: string
  connected: boolean
  toolCount: number
  lastError?: string
}

/** MCP 工具定义 */
interface McpTool {
  serverId: string
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, {
      type: string
      description?: string
      enum?: string[]
    }>
    required?: string[]
  }
}

/** 编辑表单临时状态 */
interface ServerForm {
  name: string
  transport: 'stdio' | 'sse'
  command: string
  args: string // 逗号分隔
  env: string // 每行 KEY=value
  url: string
  autoStart: boolean
}

const EMPTY_FORM: ServerForm = {
  name: '',
  transport: 'stdio',
  command: '',
  args: '',
  env: '',
  url: '',
  autoStart: true,
}

export function McpPage() {
  const navigate = useNavigate()
  const [servers, setServers] = useState<McpServerConfig[]>([])
  const [statuses, setStatuses] = useState<McpServerStatus[]>([])
  const [tools, setTools] = useState<McpTool[]>([])
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set())

  // 添加/编辑弹窗
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<ServerForm>(EMPTY_FORM)

  // 工具调用测试面板
  const [showTest, setShowTest] = useState(false)
  const [testTool, setTestTool] = useState('')
  const [testArgs, setTestArgs] = useState('{}')
  const [testResult, setTestResult] = useState<string | null>(null)
  const [testError, setTestError] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)

  // 加载数据
  const loadData = async () => {
    const [s, st, t] = await Promise.all([
      window.api.mcp.listServers(),
      window.api.mcp.listServerStatuses(),
      window.api.mcp.listTools(),
    ])
    setServers(s as McpServerConfig[])
    setStatuses(st as McpServerStatus[])
    setTools(t as McpTool[])
  }

  useEffect(() => {
    loadData()
  }, [])

  const getStatus = (id: string) => statuses.find((s) => s.id === id)
  const getServerTools = (id: string) => tools.filter((t) => t.serverId === id)

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const setBusy = (id: string, busy: boolean) => {
    setBusyIds((prev) => {
      const next = new Set(prev)
      if (busy) next.add(id)
      else next.delete(id)
      return next
    })
  }

  const openAdd = () => {
    setForm(EMPTY_FORM)
    setEditingId(null)
    setShowForm(true)
  }

  const openEdit = (s: McpServerConfig) => {
    setForm({
      name: s.name,
      transport: s.transport,
      command: s.command ?? '',
      args: s.args?.join(', ') ?? '',
      env: s.env ? Object.entries(s.env).map(([k, v]) => `${k}=${v}`).join('\n') : '',
      url: s.url ?? '',
      autoStart: s.autoStart,
    })
    setEditingId(s.id)
    setShowForm(true)
  }

  const closeForm = () => {
    setShowForm(false)
    setEditingId(null)
    setForm(EMPTY_FORM)
  }

  /** 解析逗号分隔的参数列表 */
  const parseArgs = (str: string): string[] =>
    str.split(',').map((s) => s.trim()).filter(Boolean)

  /** 解析 KEY=value 每行的环境变量 */
  const parseEnv = (str: string): Record<string, string> => {
    const env: Record<string, string> = {}
    for (const line of str.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const eqIdx = trimmed.indexOf('=')
      if (eqIdx <= 0) continue
      const key = trimmed.slice(0, eqIdx).trim()
      const val = trimmed.slice(eqIdx + 1).trim()
      if (key) env[key] = val
    }
    return env
  }

  const handleSave = async () => {
    if (!form.name.trim()) return
    const config = {
      name: form.name.trim(),
      transport: form.transport,
      command: form.transport === 'stdio' ? form.command.trim() : undefined,
      args: form.transport === 'stdio' ? parseArgs(form.args) : undefined,
      env: form.transport === 'stdio' && form.env.trim() ? parseEnv(form.env) : undefined,
      url: form.transport === 'sse' ? form.url.trim() : undefined,
      enabled: true,
      autoStart: form.autoStart,
    }
    if (editingId) {
      await window.api.mcp.updateServer(editingId, config)
    } else {
      await window.api.mcp.addServer(config)
    }
    closeForm()
    await loadData()
  }

  const handleDelete = async (id: string) => {
    await window.api.mcp.removeServer(id)
    await loadData()
  }

  const handleStart = async (id: string) => {
    setBusy(id, true)
    try {
      await window.api.mcp.startServer(id)
      await loadData()
    } finally {
      setBusy(id, false)
    }
  }

  const handleStop = async (id: string) => {
    setBusy(id, true)
    try {
      await window.api.mcp.stopServer(id)
      await loadData()
    } finally {
      setBusy(id, false)
    }
  }

  const openTest = (toolName?: string) => {
    setTestTool(toolName ?? (tools[0]?.name ?? ''))
    setTestArgs('{}')
    setTestResult(null)
    setTestError(null)
    setShowTest(true)
  }

  const handleCallTool = async () => {
    if (!testTool) return
    const tool = tools.find((t) => t.name === testTool)
    if (!tool) return
    let args: Record<string, unknown>
    try {
      args = JSON.parse(testArgs || '{}')
    } catch {
      setTestError('JSON 格式错误')
      setTestResult(null)
      return
    }
    setTesting(true)
    setTestError(null)
    setTestResult(null)
    try {
      const result = await window.api.mcp.callTool(tool.serverId, tool.name, args)
      setTestResult(JSON.stringify(result, null, 2))
    } catch (err) {
      setTestError(err instanceof Error ? err.message : String(err))
    } finally {
      setTesting(false)
    }
  }

  // 测试面板中当前选中的工具
  const selectedTool = testTool ? tools.find((t) => t.name === testTool) : undefined

  return (
    <div className="h-full flex flex-col">
      {/* 顶栏：返回 + 标题 + 添加 */}
      <header className="flex items-center justify-between px-4 h-14 border-b border-tavern-border-soft bg-tavern-bg-soft shrink-0">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate(-1)}
            className="p-1.5 rounded-lg hover:bg-tavern-bg-hover text-tavern-text"
            title="返回"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="flex items-center gap-2">
            <Server className="w-5 h-5 text-tavern-accent" />
            <h1 className="text-lg font-medium">MCP 工具</h1>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => openTest()}
            className="btn-ghost text-sm"
            disabled={tools.length === 0}
          >
            <Wrench className="w-4 h-4" />
            测试工具
          </button>
          <button onClick={openAdd} className="btn-primary text-sm">
            <Plus className="w-4 h-4" />
            添加
          </button>
        </div>
      </header>

      {/* 概览条 */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-tavern-border-soft bg-tavern-bg-soft text-xs text-tavern-text-muted">
        <span>共 {servers.length} 个 Server</span>
        <span>·</span>
        <span className="flex items-center gap-1">
          <Circle className="w-2 h-2 text-tavern-success fill-current" />
          {statuses.filter((s) => s.connected).length} 已连接
        </span>
        <span>·</span>
        <span>{tools.length} 个工具</span>
      </div>

      {/* 内容区 */}
      <div className="flex-1 overflow-y-auto p-4">
        {servers.length === 0 ? (
          <div className="text-center py-12">
            <Server className="w-12 h-12 text-tavern-text-muted mx-auto mb-3 opacity-30" />
            <p className="text-tavern-text-muted mb-3">还没有 MCP Server</p>
            <button onClick={openAdd} className="btn-primary inline-flex items-center gap-1.5">
              <Plus className="w-4 h-4" />
              添加 Server
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {servers.map((s) => {
              const status = getStatus(s.id)
              const isConnected = status?.connected ?? false
              const isExpanded = expandedIds.has(s.id)
              const serverTools = getServerTools(s.id)
              const isBusy = busyIds.has(s.id)
              return (
                <div
                  key={s.id}
                  className="rounded-xl border border-tavern-border-soft bg-tavern-bg-card overflow-hidden"
                >
                  {/* 行头 */}
                  <div className="flex items-center justify-between px-4 py-3">
                    <button
                      onClick={() => toggleExpand(s.id)}
                      className="flex items-center gap-3 min-w-0 flex-1 text-left"
                    >
                      {isExpanded ? (
                        <ChevronDown className="w-4 h-4 text-tavern-text-muted shrink-0" />
                      ) : (
                        <ChevronRight className="w-4 h-4 text-tavern-text-muted shrink-0" />
                      )}
                      <Circle
                        className={cn(
                          'w-2.5 h-2.5 shrink-0',
                          isConnected
                            ? 'text-tavern-success fill-current animate-pulse-soft'
                            : 'text-tavern-text-muted'
                        )}
                      />
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-tavern-text truncate">{s.name}</div>
                        <div className="text-xs text-tavern-text-muted flex items-center gap-2">
                          <span className="flex items-center gap-1">
                            {s.transport === 'stdio' ? (
                              <Terminal className="w-3 h-3" />
                            ) : (
                              <Globe className="w-3 h-3" />
                            )}
                            {s.transport}
                          </span>
                          <span>·</span>
                          <span>{status?.toolCount ?? 0} 工具</span>
                          {s.autoStart && (
                            <>
                              <span>·</span>
                              <span>自动启动</span>
                            </>
                          )}
                        </div>
                      </div>
                    </button>
                    <div className="flex items-center gap-1 shrink-0">
                      {isConnected ? (
                        <button
                          onClick={() => handleStop(s.id)}
                          disabled={isBusy}
                          className="p-1.5 rounded-lg text-tavern-text-muted hover:text-tavern-danger hover:bg-tavern-danger/10 transition-colors disabled:opacity-50"
                          title="停止"
                        >
                          {isBusy ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <Square className="w-4 h-4" />
                          )}
                        </button>
                      ) : (
                        <button
                          onClick={() => handleStart(s.id)}
                          disabled={isBusy}
                          className="p-1.5 rounded-lg text-tavern-text-muted hover:text-tavern-success hover:bg-tavern-success/10 transition-colors disabled:opacity-50"
                          title="启动"
                        >
                          {isBusy ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <Play className="w-4 h-4" />
                          )}
                        </button>
                      )}
                      <button
                        onClick={() => openEdit(s)}
                        className="p-1.5 rounded-lg text-tavern-text-muted hover:text-tavern-accent hover:bg-tavern-accent/10 transition-colors"
                        title="编辑"
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => handleDelete(s.id)}
                        className="p-1.5 rounded-lg text-tavern-text-muted hover:text-tavern-danger hover:bg-tavern-danger/10 transition-colors"
                        title="删除"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  {/* 展开内容 */}
                  {isExpanded && (
                    <div className="px-4 pb-4 pt-1 border-t border-tavern-border-soft space-y-3">
                      {/* 错误信息 */}
                      {status?.lastError && (
                        <p className="text-xs text-tavern-danger bg-tavern-danger/5 rounded px-2 py-1.5 break-all">
                          {status.lastError}
                        </p>
                      )}

                      {/* 配置详情 */}
                      <div className="text-xs space-y-1 bg-tavern-bg rounded-lg p-2.5 border border-tavern-border-soft">
                        {s.transport === 'stdio' ? (
                          <>
                            <div>
                              <span className="text-tavern-text-muted">command:</span>{' '}
                              <span className="font-mono text-tavern-text-soft">
                                {s.command || '-'}
                              </span>
                            </div>
                            {s.args && s.args.length > 0 && (
                              <div>
                                <span className="text-tavern-text-muted">args:</span>{' '}
                                <span className="font-mono text-tavern-text-soft">
                                  {s.args.join(' ')}
                                </span>
                              </div>
                            )}
                            {s.env && Object.keys(s.env).length > 0 && (
                              <div>
                                <span className="text-tavern-text-muted">env:</span>{' '}
                                <span className="font-mono text-tavern-text-soft">
                                  {Object.keys(s.env).length} 项
                                </span>
                              </div>
                            )}
                          </>
                        ) : (
                          <div>
                            <span className="text-tavern-text-muted">url:</span>{' '}
                            <span className="font-mono text-tavern-text-soft break-all">
                              {s.url || '-'}
                            </span>
                          </div>
                        )}
                      </div>

                      {/* 工具列表 */}
                      <div>
                        <div className="flex items-center gap-1.5 mb-2 text-xs text-tavern-text-muted">
                          <Wrench className="w-3 h-3" />
                          工具 ({serverTools.length})
                        </div>
                        {serverTools.length === 0 ? (
                          <p className="text-xs text-tavern-text-muted py-2">
                            暂无工具{!isConnected && '（未连接）'}
                          </p>
                        ) : (
                          <div className="space-y-2">
                            {serverTools.map((tool) => (
                              <div
                                key={tool.name}
                                className="rounded-lg border border-tavern-border-soft bg-tavern-bg p-2.5"
                              >
                                <div className="flex items-center justify-between gap-2">
                                  <div className="min-w-0">
                                    <div className="text-xs font-mono font-medium text-tavern-text">
                                      {tool.name}
                                    </div>
                                    {tool.description && (
                                      <div className="text-xs text-tavern-text-muted mt-0.5 break-words">
                                        {tool.description}
                                      </div>
                                    )}
                                  </div>
                                  <button
                                    onClick={() => openTest(tool.name)}
                                    className="text-xs px-2 py-0.5 rounded border border-tavern-border-soft text-tavern-text-muted hover:text-tavern-accent hover:border-tavern-accent transition-colors shrink-0"
                                  >
                                    测试
                                  </button>
                                </div>
                                {/* 参数 schema */}
                                {tool.inputSchema?.properties &&
                                  Object.keys(tool.inputSchema.properties).length > 0 && (
                                    <div className="mt-2 space-y-1">
                                      {Object.entries(tool.inputSchema.properties).map(
                                        ([key, prop]) => (
                                          <div
                                            key={key}
                                            className="text-xs flex items-start gap-2"
                                          >
                                            <span className="font-mono text-tavern-accent shrink-0">
                                              {key}
                                            </span>
                                            <span className="text-tavern-text-muted shrink-0">
                                              {prop.type}
                                            </span>
                                            {tool.inputSchema.required?.includes(key) && (
                                              <span className="text-tavern-danger shrink-0">*</span>
                                            )}
                                            {prop.description && (
                                              <span className="text-tavern-text-soft break-words">
                                                {prop.description}
                                              </span>
                                            )}
                                            {prop.enum && (
                                              <span className="text-tavern-text-muted shrink-0">
                                                [{prop.enum.join(', ')}]
                                              </span>
                                            )}
                                          </div>
                                        )
                                      )}
                                    </div>
                                  )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}

            {/* 底部添加按钮 */}
            <button
              onClick={openAdd}
              className="w-full flex items-center justify-center gap-1.5 py-3 rounded-xl border-2 border-dashed border-tavern-border-soft text-tavern-text-muted hover:border-tavern-accent hover:text-tavern-accent transition-colors"
            >
              <Plus className="w-4 h-4" />
              <span className="text-sm">添加 Server</span>
            </button>
          </div>
        )}
      </div>

      {/* 添加/编辑 Server 弹窗 */}
      {showForm && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          onClick={closeForm}
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
                onClick={closeForm}
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
              <button onClick={closeForm} className="btn-ghost text-sm">
                取消
              </button>
              <button
                onClick={handleSave}
                disabled={!form.name.trim()}
                className="btn-primary text-sm"
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 工具调用测试面板 */}
      {showTest && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          onClick={() => setShowTest(false)}
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
                onClick={() => setShowTest(false)}
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
                onClick={handleCallTool}
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
      )}
    </div>
  )
}
