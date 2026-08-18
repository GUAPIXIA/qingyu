import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Trash2, Download, Hash, Type } from 'lucide-react'
import { cn } from '../lib/utils'
import { formatCharCount } from '../utils/charCounter'

type GroupBy = 'character' | 'session' | 'day' | 'model'
type TimeRange = 'today' | '7d' | '30d' | 'all'

export function UsagePage() {
  const navigate = useNavigate()
  const [summary, setSummary] = useState<{ totalInput: number; totalOutput: number; totalChars: number; count: number } | null>(null)
  const [records, setRecords] = useState<Array<{ key: string; inputChars: number; outputChars: number; totalChars: number; count: number }>>([])
  const [groupBy, setGroupBy] = useState<GroupBy>('character')
  const [timeRange, setTimeRange] = useState<TimeRange>('all')
  const [showClearConfirm, setShowClearConfirm] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  // 分组 key -> 显示名称映射
  const [keyNameMap, setKeyNameMap] = useState<Record<string, string>>({})

  // 按时间范围与分组维度加载数据
  const loadData = useCallback(async () => {
    setLoadError(null)
    const now = Date.now()
    const ranges: Record<TimeRange, number | undefined> = {
      today: now - 24 * 60 * 60 * 1000,
      '7d': now - 7 * 24 * 60 * 60 * 1000,
      '30d': now - 30 * 24 * 60 * 60 * 1000,
      all: undefined,
    }
    const startTs = ranges[timeRange]
    const filter = startTs ? { startTs } : {}
    const [summaryR, recordsR] = await Promise.allSettled([
      window.api.usage.summary(filter),
      window.api.usage.aggregate(filter, groupBy),
    ])
    if (summaryR.status === 'fulfilled') setSummary(summaryR.value)
    if (recordsR.status === 'fulfilled') setRecords(recordsR.value)
    if (summaryR.status === 'rejected' || recordsR.status === 'rejected') {
      setLoadError('部分用量数据加载失败')
    }

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
      for (const rec of (recordsR.status === 'fulfilled' ? recordsR.value : [])) {
        const charName = sessionCharMap.get(rec.key) ?? ''
        nameMap[rec.key] = charName || rec.key
      }
    }
    setKeyNameMap(nameMap)
  }, [groupBy, timeRange])

  useEffect(() => {
    loadData()
  }, [loadData])

  // 实时刷新：监听 AI 调用完成事件
  useEffect(() => {
    const refresh = () => {
      // 延迟 200ms 等待记录写入完成
      setTimeout(() => loadData(), 200)
    }
    const unbindUsage = window.api.ai.onUsage?.(refresh)
    const unbindDone = window.api.ai.onDone(refresh)
    return () => {
      if (typeof unbindUsage === 'function') unbindUsage()
      if (typeof unbindDone === 'function') unbindDone()
    }
  }, [loadData])

  const handleClear = async () => {
    await window.api.usage.clear()
    setShowClearConfirm(false)
    loadData()
  }

  // 导出为 CSV（含 BOM 以兼容 Excel 中文显示）
  const handleExportCsv = () => {
    const headers = ['分组', '输入字符', '输出字符', '总字符', '调用次数']
    const rows = records.map(r => [
      resolveKeyName(r.key),
      r.inputChars,
      r.outputChars,
      r.totalChars,
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
  const maxDailyChars = dailyData.length > 0 ? Math.max(...dailyData.map(r => r.totalChars)) : 1

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

      {loadError && (
        <div className="mx-6 mt-3 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-sm dark:bg-amber-900/30 dark:border-amber-700 dark:text-amber-200">
          ⚠️ {loadError}
        </div>
      )}

      {/* 内容 */}
      <div className="flex-1 overflow-y-auto p-6">
        {/* 汇总卡片 */}
        <div className="grid grid-cols-2 gap-4 mb-6">
          <div className="bg-tavern-bg-soft rounded-xl p-4 border border-tavern-border-soft">
            <div className="flex items-center gap-2 text-tavern-text-muted text-xs mb-2">
              <Type className="w-4 h-4" /> 总字符数
            </div>
            <div className="text-2xl font-semibold tabular-nums">
              {summary ? formatCharCount(summary.totalChars) : '-'}
            </div>
            <div className="text-xs text-tavern-text-muted mt-1">
              输入 {summary ? formatCharCount(summary.totalInput) : '-'} · 输出 {summary ? formatCharCount(summary.totalOutput) : '-'}
            </div>
          </div>
          <div className="bg-tavern-bg-soft rounded-xl p-4 border border-tavern-border-soft">
            <div className="flex items-center gap-2 text-tavern-text-muted text-xs mb-2">
              <Hash className="w-4 h-4" /> 调用次数
            </div>
            <div className="text-2xl font-semibold tabular-nums">
              {summary ? summary.count : '-'}
            </div>
            <div className="text-xs text-tavern-text-muted mt-1">次 AI 调用</div>
          </div>
        </div>

        {/* 日趋势图表 */}
        {dailyData.length > 0 && (
          <div className="bg-tavern-bg-soft rounded-xl p-4 border border-tavern-border-soft mb-6">
            <div className="text-sm font-medium mb-3">每日字符用量趋势</div>
            <div className="flex items-end gap-1" style={{ height: '120px' }}>
              {dailyData.map((d, i) => {
                const height = maxDailyChars > 0 ? (d.totalChars / maxDailyChars) * 100 : 0
                return (
                  <div key={i} className="flex-1 flex flex-col items-center gap-1 min-w-0" title={`${d.key}: ${formatCharCount(d.totalChars)} 字符`}>
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
                <th className="px-4 py-3 text-right font-medium">输入字符</th>
                <th className="px-4 py-3 text-right font-medium">输出字符</th>
                <th className="px-4 py-3 text-right font-medium">总字符</th>
                <th className="px-4 py-3 text-right font-medium">次数</th>
              </tr>
            </thead>
            <tbody>
              {records.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-12 text-center text-tavern-text-muted">
                    暂无数据
                  </td>
                </tr>
              ) : (
                records.map((r, i) => (
                  <tr key={i} className="border-b border-tavern-border-soft/50 last:border-0 hover:bg-tavern-bg-hover/50">
                    <td className="px-4 py-3 text-sm font-medium">{resolveKeyName(r.key)}</td>
                    <td className="px-4 py-3 text-sm text-right tabular-nums text-tavern-text-muted">{formatCharCount(r.inputChars)}</td>
                    <td className="px-4 py-3 text-sm text-right tabular-nums text-tavern-text-muted">{formatCharCount(r.outputChars)}</td>
                    <td className="px-4 py-3 text-sm text-right tabular-nums font-medium">{formatCharCount(r.totalChars)}</td>
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
