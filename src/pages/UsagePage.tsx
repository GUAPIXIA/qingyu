import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Trash2, Download, TrendingUp, Hash, DollarSign } from 'lucide-react'
import { cn } from '../lib/utils'

type GroupBy = 'character' | 'session' | 'day' | 'model'
type TimeRange = 'today' | '7d' | '30d' | 'all'

export function UsagePage() {
  const navigate = useNavigate()
  const [summary, setSummary] = useState<{ totalPrompt: number; totalCompletion: number; totalTokens: number; totalCost: number; count: number } | null>(null)
  const [records, setRecords] = useState<Array<{ key: string; promptTokens: number; completionTokens: number; totalTokens: number; cost: number; count: number }>>([])
  const [groupBy, setGroupBy] = useState<GroupBy>('character')
  const [timeRange, setTimeRange] = useState<TimeRange>('all')
  const [showClearConfirm, setShowClearConfirm] = useState(false)
  // 分组 key → 显示名称映射
  const [keyNameMap, setKeyNameMap] = useState<Record<string, string>>({})

  // 按时间范围与分组维度加载数据
  const loadData = useCallback(async () => {
    const now = Date.now()
    const ranges: Record<TimeRange, number | undefined> = {
      today: now - 24 * 60 * 60 * 1000,
      '7d': now - 7 * 24 * 60 * 60 * 1000,
      '30d': now - 30 * 24 * 60 * 60 * 1000,
      all: undefined,
    }
    const startTs = ranges[timeRange]
    const filter = startTs ? { startTs } : {}
    const [s, r] = await Promise.all([
      window.api.usage.summary(filter),
      window.api.usage.aggregate(filter, groupBy),
    ])
    setSummary(s)
    setRecords(r)

    // 解析分组 key 为可读名称
    const nameMap: Record<string, string> = {}
    if (groupBy === 'character') {
      const characters = await window.api.character.list()
      for (const c of characters) {
        nameMap[c.id] = c.name
      }
    } else if (groupBy === 'session') {
      const characters = await window.api.character.list()
      const charMap = new Map(characters.map(c => [c.id, c.name]))
      // aggregate 只返回 key=session 的数据，需查询原始记录反查 characterId
      const rawRecords = await window.api.usage.query(filter)
      const sessionCharMap = new Map<string, string>()
      for (const rec of rawRecords) {
        if (!sessionCharMap.has(rec.sessionId)) {
          sessionCharMap.set(rec.sessionId, charMap.get(rec.characterId) ?? rec.characterId)
        }
      }
      for (const rec of r) {
        const charName = sessionCharMap.get(rec.key) ?? ''
        nameMap[rec.key] = charName || rec.key
      }
    }
    setKeyNameMap(nameMap)
  }, [groupBy, timeRange])

  useEffect(() => {
    loadData()
  }, [loadData])

  // 实时刷新：监听 ai:usage 事件
  useEffect(() => {
    const unsubscribe = window.api.ai.onUsage?.(() => {
      // 延迟 100ms 等待记录写入完成
      setTimeout(() => loadData(), 100)
    })
    return () => {
      if (typeof unsubscribe === 'function') unsubscribe()
    }
  }, [loadData])

  const handleClear = async () => {
    await window.api.usage.clear()
    setShowClearConfirm(false)
    loadData()
  }

  // 导出为 CSV（含 BOM 以兼容 Excel 中文显示）
  const handleExportCsv = () => {
    const headers = ['分组', '输入Token', '输出Token', '总Token', '费用($)', '调用次数']
    const rows = records.map(r => [
      resolveKeyName(r.key),
      r.promptTokens,
      r.completionTokens,
      r.totalTokens,
      r.cost.toFixed(4),
      r.count,
    ])
    const csv = [headers, ...rows].map(row => row.join(',')).join('\n')
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `usage-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const formatTokens = (n: number) => {
    if (n >= 1000000) return `${(n / 1000000).toFixed(2)}M`
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
    return n.toString()
  }

  const formatCost = (n: number) => {
    if (n === 0) return '-'
    if (n < 0.01) return `<$0.01`
    return `$${n.toFixed(2)}`
  }

  /** 解析分组 key 为显示名称 */
  const resolveKeyName = (key: string) => {
    return keyNameMap[key] ?? key
  }

  const groupByOptions: Array<{ value: GroupBy; label: string }> = [
    { value: 'character', label: '按角色' },
    { value: 'session', label: '按对话' },
    { value: 'day', label: '按天' },
    { value: 'model', label: '按模型' },
  ]

  const timeRangeOptions: Array<{ value: TimeRange; label: string }> = [
    { value: 'today', label: '今日' },
    { value: '7d', label: '7天' },
    { value: '30d', label: '30天' },
    { value: 'all', label: '全部' },
  ]

  // 日趋势图表数据
  const dailyData = groupBy === 'day' ? records.slice().reverse() : []
  const maxDailyTokens = dailyData.length > 0 ? Math.max(...dailyData.map(r => r.totalTokens)) : 1

  return (
    <div className="h-full flex flex-col">
      {/* 顶栏 */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-tavern-border">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate(-1)} className="p-1.5 rounded-lg hover:bg-tavern-bg-hover">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <h1 className="text-lg font-medium">用量统计</h1>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={handleExportCsv} className="btn-ghost flex items-center gap-1.5 text-sm">
            <Download className="w-4 h-4" /> 导出 CSV
          </button>
          <button onClick={() => setShowClearConfirm(true)} className="btn-ghost flex items-center gap-1.5 text-sm text-tavern-danger">
            <Trash2 className="w-4 h-4" /> 清空
          </button>
        </div>
      </div>

      {/* 内容 */}
      <div className="flex-1 overflow-y-auto p-6">
        {/* 汇总卡片 */}
        <div className="grid grid-cols-3 gap-4 mb-6">
          <div className="bg-tavern-bg-soft rounded-xl p-4 border border-tavern-border-soft">
            <div className="flex items-center gap-2 text-tavern-text-muted text-xs mb-2">
              <TrendingUp className="w-4 h-4" /> 总 Token
            </div>
            <div className="text-2xl font-semibold tabular-nums">
              {summary ? formatTokens(summary.totalTokens) : '-'}
            </div>
            <div className="text-xs text-tavern-text-muted mt-1">
              输入 {summary ? formatTokens(summary.totalPrompt) : '-'} · 输出 {summary ? formatTokens(summary.totalCompletion) : '-'}
            </div>
          </div>
          <div className="bg-tavern-bg-soft rounded-xl p-4 border border-tavern-border-soft">
            <div className="flex items-center gap-2 text-tavern-text-muted text-xs mb-2">
              <Hash className="w-4 h-4" /> 调用次数
            </div>
            <div className="text-2xl font-semibold tabular-nums">
              {summary ? summary.count : '-'}
            </div>
            <div className="text-xs text-tavern-text-muted mt-1">次 API 调用</div>
          </div>
          <div className="bg-tavern-bg-soft rounded-xl p-4 border border-tavern-border-soft">
            <div className="flex items-center gap-2 text-tavern-text-muted text-xs mb-2">
              <DollarSign className="w-4 h-4" /> 总费用
            </div>
            <div className="text-2xl font-semibold tabular-nums">
              {summary ? formatCost(summary.totalCost) : '-'}
            </div>
            <div className="text-xs text-tavern-text-muted mt-1">
              {summary && summary.count > 0 ? `平均 ${formatCost(summary.totalCost / summary.count)}/次` : '-'}
            </div>
          </div>
        </div>

        {/* 日趋势图表 */}
        {dailyData.length > 0 && (
          <div className="bg-tavern-bg-soft rounded-xl p-4 border border-tavern-border-soft mb-6">
            <div className="text-sm font-medium mb-3">每日用量趋势</div>
            <div className="flex items-end gap-1" style={{ height: '120px' }}>
              {dailyData.map((d, i) => {
                const height = maxDailyTokens > 0 ? (d.totalTokens / maxDailyTokens) * 100 : 0
                return (
                  <div key={i} className="flex-1 flex flex-col items-center gap-1 min-w-0" title={`${d.key}: ${formatTokens(d.totalTokens)} tokens`}>
                    <div className="w-full flex flex-col justify-end" style={{ height: '100px' }}>
                      <div
                        className="w-full rounded-t bg-tavern-accent/70 hover:bg-tavern-accent transition-colors min-h-[2px]"
                        style={{ height: `${Math.max(height, 2)}%` }}
                      />
                    </div>
                    <span className="text-[10px] text-tavern-text-muted truncate w-full text-center">
                      {d.key.slice(5)}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* 筛选器 */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex gap-1 p-1 bg-tavern-bg-soft rounded-lg">
            {groupByOptions.map(opt => (
              <button
                key={opt.value}
                onClick={() => setGroupBy(opt.value)}
                className={cn(
                  'px-3 py-1.5 rounded-md text-sm transition-colors',
                  groupBy === opt.value ? 'bg-tavern-accent text-white' : 'text-tavern-text-muted hover:text-tavern-text'
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <div className="flex gap-1 p-1 bg-tavern-bg-soft rounded-lg">
            {timeRangeOptions.map(opt => (
              <button
                key={opt.value}
                onClick={() => setTimeRange(opt.value)}
                className={cn(
                  'px-3 py-1.5 rounded-md text-sm transition-colors',
                  timeRange === opt.value ? 'bg-tavern-bg-hover text-tavern-text' : 'text-tavern-text-muted hover:text-tavern-text'
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* 数据表格 */}
        <div className="bg-tavern-bg-soft rounded-xl border border-tavern-border-soft overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-tavern-border-soft text-xs text-tavern-text-muted">
                <th className="px-4 py-3 text-left font-medium">分组</th>
                <th className="px-4 py-3 text-right font-medium">输入 Token</th>
                <th className="px-4 py-3 text-right font-medium">输出 Token</th>
                <th className="px-4 py-3 text-right font-medium">总 Token</th>
                <th className="px-4 py-3 text-right font-medium">费用</th>
                <th className="px-4 py-3 text-right font-medium">次数</th>
              </tr>
            </thead>
            <tbody>
              {records.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-tavern-text-muted">
                    暂无数据
                  </td>
                </tr>
              ) : (
                records.map((r, i) => (
                  <tr key={i} className="border-b border-tavern-border-soft/50 last:border-0 hover:bg-tavern-bg-hover/50">
                    <td className="px-4 py-3 text-sm font-medium">{resolveKeyName(r.key)}</td>
                    <td className="px-4 py-3 text-sm text-right tabular-nums text-tavern-text-muted">{formatTokens(r.promptTokens)}</td>
                    <td className="px-4 py-3 text-sm text-right tabular-nums text-tavern-text-muted">{formatTokens(r.completionTokens)}</td>
                    <td className="px-4 py-3 text-sm text-right tabular-nums font-medium">{formatTokens(r.totalTokens)}</td>
                    <td className="px-4 py-3 text-sm text-right tabular-nums text-tavern-text-muted">{formatCost(r.cost)}</td>
                    <td className="px-4 py-3 text-sm text-right tabular-nums text-tavern-text-muted">{r.count}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* 清空确认 */}
      {showClearConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowClearConfirm(false)}>
          <div className="bg-tavern-bg-soft rounded-xl p-6 max-w-sm mx-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-medium mb-2">确认清空</h3>
            <p className="text-sm text-tavern-text-muted mb-4">这将删除所有用量统计记录，无法恢复。</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowClearConfirm(false)} className="btn-ghost">取消</button>
              <button onClick={handleClear} className="btn-danger">确认清空</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
