import { useState } from 'react'
import { RefreshCw } from 'lucide-react'

/** Markdown 内嵌图片组件：加载失败时显示重试按钮 */
export function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const [error, setError] = useState(false)
  if (!src) return null
  if (error) {
    return (
      <button
        onClick={() => setError(false)}
        className="inline-flex items-center gap-1 px-2 py-1 rounded bg-tavern-bg-hover text-xs text-tavern-text-muted cursor-pointer hover:bg-tavern-bg-hover/80 transition-colors"
        title="点击重新加载图片"
      >
        <RefreshCw className="w-3 h-3" />
        <span>{alt || '图片加载失败'}</span>
      </button>
    )
  }
  return (
    <img
      src={src}
      alt={alt}
      onError={() => setError(true)}
      className="max-w-full rounded cursor-pointer hover:opacity-80 transition-opacity"
    />
  )
}
