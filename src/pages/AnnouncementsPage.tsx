import { useEffect, useState, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '../lib/utils'
import { useAnnouncementStore } from '../store/useAnnouncementStore'
import {
  Megaphone,
  Pin,
  ArrowLeft,
  Calendar,
  Loader2,
  AlertCircle,
  Inbox,
  RefreshCw,
  WifiOff,
} from 'lucide-react'

export function AnnouncementsPage() {
  const {
    announcements,
    selectedAnnouncement,
    loading,
    error,
    loadAnnouncements,
    selectAnnouncement,
    clearSelection,
  } = useAnnouncementStore()
  const [lastUpdated, setLastUpdated] = useState<number | null>(null)
  const [readIds, setReadIds] = useState<Set<number>>(() => {
    try { const raw = localStorage.getItem('announcement-read'); return new Set(raw ? JSON.parse(raw) : []) } catch { return new Set() }
  })
  const isOffline = !!error && announcements.length > 0

  const handleLoad = useCallback(async () => {
    await loadAnnouncements()
    setLastUpdated(Date.now())
  }, [loadAnnouncements])

  const handleSelect = useCallback(async (id: number) => {
    await selectAnnouncement(id)
    setReadIds(prev => {
      const next = new Set(prev); next.add(id)
      try { localStorage.setItem('announcement-read', JSON.stringify([...next])) } catch { /* ignore */ }
      return next
    })
  }, [selectAnnouncement])

  useEffect(() => {
    handleLoad()
  }, [handleLoad])

  // 详情视图
  if (selectedAnnouncement) {
    return (
      <div className="flex-1 flex flex-col overflow-hidden">
        <header className="flex items-center gap-3 px-4 h-14 border-b border-tavern-border-soft bg-tavern-bg-soft shrink-0">
          <button
            onClick={clearSelection}
            className="p-1.5 rounded-lg hover:bg-tavern-bg-hover text-tavern-text-muted hover:text-tavern-text transition-colors"
            title="返回列表"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <h1 className="font-display text-lg font-bold truncate">{selectedAnnouncement.title}</h1>
        </header>
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-4xl mx-auto p-4">
            <div className="card p-5">
              <div className="flex items-center gap-2 mb-4 text-xs text-tavern-text-muted">
                {!!selectedAnnouncement.pinned && (
                  <span className="flex items-center gap-1 px-2 py-0.5 rounded bg-tavern-accent-soft text-tavern-accent">
                    <Pin className="w-3 h-3" />
                    置顶
                  </span>
                )}
                <span className="flex items-center gap-1">
                  <Calendar className="w-3 h-3" />
                  {selectedAnnouncement.createdAt.slice(0, 10)}
                </span>
              </div>
              <div className="prose prose-sm prose-invert max-w-none select-text">
                {/* 安全修复：移除 rehypeRaw。公告内容来自服务器，含不可信 HTML 时
                    原始 HTML 会被渲染执行（存储型 XSS）。不渲染 HTML，仅支持 GFM */}
                {selectedAnnouncement.content ? (
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      a: ({ href, children }) => (
                        <a
                          href={href}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-tavern-accent underline hover:opacity-80"
                        >
                          {children}
                        </a>
                      ),
                      code: ({ className, children, ...props }: { className?: string; children?: React.ReactNode }) => {
                        const isInline = !className
                        if (isInline) {
                          return (
                            <code className="px-1 py-0.5 rounded bg-tavern-bg-soft text-tavern-accent text-xs" {...props}>
                              {children}
                            </code>
                          )
                        }
                        return (
                          <pre className="rounded-lg bg-tavern-bg-soft p-3 overflow-x-auto text-xs">
                            <code className={className} {...props}>{children}</code>
                          </pre>
                        )
                      },
                    }}
                  >
                    {selectedAnnouncement.content}
                  </ReactMarkdown>
                ) : (
                  // N19 修复：列表接口不再返回 content，详情获取失败（离线等）时降级提示
                  <p className="text-sm text-tavern-text-muted py-4">
                    公告详情加载失败，请检查网络后重试
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // 列表视图
  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <header className="flex items-center justify-between px-4 h-14 border-b border-tavern-border-soft bg-tavern-bg-soft shrink-0 gap-2">
        <h1 className="font-display text-lg font-bold flex items-center gap-2">
          <Megaphone className="w-5 h-5 text-tavern-accent" />
          公告
          {announcements.some(a => !readIds.has(a.id)) && <span className="w-2 h-2 rounded-full bg-tavern-accent animate-pulse" aria-label="有未读公告" />}
        </h1>
        <div className="flex items-center gap-2">
          {lastUpdated && <span className="hidden sm:inline text-xs text-tavern-text-muted">{new Date(lastUpdated).toLocaleTimeString()} 更新</span>}
          {isOffline && <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300"><WifiOff className="w-3 h-3" /> 离线缓存</span>}
          <button onClick={handleLoad} disabled={loading} aria-label="刷新公告" className="p-1.5 rounded-lg hover:bg-tavern-bg-hover text-tavern-text-muted hover:text-tavern-text disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-tavern-accent focus-visible:outline-none">
            <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} aria-hidden />
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto p-4">

          {/* 加载态 */}
          {loading && (
            <div className="flex items-center justify-center py-16 text-tavern-text-muted">
              <Loader2 className="w-5 h-5 animate-spin mr-2" />
              加载中...
            </div>
          )}

          {/* 错误态 */}
          {!loading && error && (
            <div className="card p-8 text-center">
              <AlertCircle className="w-10 h-10 text-tavern-danger mx-auto mb-3 opacity-50" />
              <p className="text-sm text-tavern-text-muted mb-3">{error}</p>
              <button
                onClick={loadAnnouncements}
                className="px-4 py-2 rounded-lg bg-tavern-accent-soft text-tavern-accent text-sm font-medium hover:opacity-80 transition-opacity"
              >
                重试
              </button>
            </div>
          )}

          {/* 空状态 */}
          {!loading && !error && announcements.length === 0 && (
            <div className="card p-8 text-center">
              <Inbox className="w-10 h-10 text-tavern-text-muted mx-auto mb-3 opacity-50" />
              <p className="text-sm text-tavern-text-muted">暂无公告</p>
            </div>
          )}

          {/* 公告列表 */}
          {!loading && announcements.length > 0 && (
            <div className="space-y-3">
              {announcements.map((a) => {
                const isUnread = !readIds.has(a.id)
                return (
                <button
                  key={a.id}
                  onClick={() => handleSelect(a.id)}
                  className={cn(
                    'w-full text-left card p-4 hover:border-tavern-accent/30 transition-colors',
                    !!a.pinned && 'ring-1 ring-tavern-accent/20'
                  )}
                >
                  <div className="flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        {isUnread && <span className="w-2 h-2 rounded-full bg-tavern-accent shrink-0" aria-hidden />}
                        {!!a.pinned && (
                          <span className="flex items-center gap-1 text-xs text-tavern-accent">
                            <Pin className="w-3 h-3" />
                            置顶
                          </span>
                        )}
                        <h3 className={cn('font-medium text-sm truncate', isUnread ? 'text-tavern-text' : 'text-tavern-text-muted')}>
                          {a.title}
                        </h3>
                      </div>
                      {a.summary && (
                        <p className="text-xs text-tavern-text-muted line-clamp-2 mt-1">
                          {a.summary}
                        </p>
                      )}
                    </div>
                    <span className="text-[11px] text-tavern-text-muted shrink-0 mt-0.5">
                      {a.createdAt.slice(0, 10)}
                    </span>
                  </div>
                </button>
                )
              }
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
