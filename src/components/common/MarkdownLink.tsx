import type { ReactNode } from 'react'

/**
 * Markdown 内嵌链接组件（安全渲染）：
 * - 仅 http/https 链接渲染为可点击 <a>，target=_blank 由主进程
 *   setWindowOpenHandler 拦截并转系统浏览器打开，不会导航主窗口
 * - 其他协议（javascript: / data: / file: / vbscript: 等）降级为纯文本，
 *   防止点击执行脚本或导航到本地资源
 */
export function MarkdownLink({ href, children }: { href?: string; children?: ReactNode }) {
  if (typeof href === 'string' && /^https?:\/\//i.test(href)) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-tavern-accent underline hover:opacity-80"
      >
        {children}
      </a>
    )
  }
  return <span className="text-tavern-text">{children}</span>
}
