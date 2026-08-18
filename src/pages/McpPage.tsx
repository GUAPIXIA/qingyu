import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { cn } from '../lib/utils'
import { McpServerFormModal } from './mcp/McpServerFormModal'
import { McpTestPanel } from './mcp/McpTestPanel'
import { EMPTY_FORM } from './mcp/mcpTypes'
import type { McpServerConfig, McpServerStatus, McpTool, ServerForm } from './mcp/mcpTypes'
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
  Terminal,
  Globe,
} from 'lucide-react'

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
  const [loadError, setLoadError] = useState<string | null>(null)

  // 加载数据
  const loadData = async () => {
    setLoadError(null)
    const [serversR, statusesR, toolsR] = await Promise.allSettled([
      window.api.mcp.listServers(),
      window.api.mcp.listServerStatuses(),
      window.api.mcp.listTools(),
    ])
    if (serversR.status === 'fulfilled') setServers(serversR.value as McpServerConfig[])
    if (statusesR.status === 'fulfilled') setStatuses(statusesR.value as McpServerStatus[])
    if (toolsR.status === 'fulfilled') setTools(toolsR.value as McpTool[])
    const failures = [serversR, statusesR, toolsR].filter(r => r.status === 'rejected')
    if (failures.length > 0) setLoadError(`部分数据加载失败（${failures.length}/3）`)
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

      {loadError && (
        <div className="mx-4 mt-3 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-sm dark:bg-amber-900/30 dark:border-amber-700 dark:text-amber-200">
          ⚠️ {loadError}
        </div>
      )}

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

      {/* 添加/编辑 Server 弹窗（P-8 拆至 McpServerFormModal） */}
      {showForm && (
        <McpServerFormModal
          editingId={editingId}
          form={form}
          setForm={setForm}
          onSave={handleSave}
          onClose={closeForm}
        />
      )}

      {/* 工具调用测试面板（P-8 拆至 McpTestPanel） */}
      {showTest && (
        <McpTestPanel
          tools={tools}
          servers={servers}
          testTool={testTool}
          setTestTool={setTestTool}
          testArgs={testArgs}
          setTestArgs={setTestArgs}
          testResult={testResult}
          testError={testError}
          testing={testing}
          onCall={handleCallTool}
          onClose={() => setShowTest(false)}
        />
      )}
    </div>
  )
}
