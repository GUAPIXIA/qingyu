import { useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
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

  useEffect(() => {
    loadAnnouncements()
  }, [loadAnnouncements])

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
            <div className="card p-5 select-text">
              <div className="flex items-center gap-2 mb-4 text-xs text-tavern-text-muted">
                {selectedAnnouncement.pinned && (
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
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeRaw]}
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
                    code: ({ className, children, ...props }: any) => {
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
      <header className="flex items-center px-4 h-14 border-b border-tavern-border-soft bg-tavern-bg-soft shrink-0">
        <h1 className="font-display text-lg font-bold flex items-center gap-2">
          <Megaphone className="w-5 h-5 text-tavern-accent" />
          公告
        </h1>
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
              {announcements.map((a) => (
                <button
                  key={a.id}
                  onClick={() => selectAnnouncement(a.id)}
                  className={cn(
                    'w-full text-left card p-4 hover:border-tavern-accent/30 transition-colors',
                    a.pinned && 'ring-1 ring-tavern-accent/20'
                  )}
                >
                  <div className="flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        {a.pinned && (
                          <span className="flex items-center gap-1 text-xs text-tavern-accent">
                            <Pin className="w-3 h-3" />
                            置顶
                          </span>
                        )}
                        <h3 className="font-medium text-sm text-tavern-text truncate">
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
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
