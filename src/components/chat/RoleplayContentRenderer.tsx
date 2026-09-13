import React, { useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { cn } from '../../lib/utils'
import { MarkdownImage } from '../common/MarkdownImage'
import { MarkdownLink } from '../common/MarkdownLink'
import { remarkRoleplay, remarkMentionHighlight } from '../../utils/remark-roleplay'
import { remarkAudio } from '../../utils/remark-audio'
import {
  parseRoleplayBlocks,
  stripOuterQuotes,
  splitQuoteSegments,
  type RoleplayParsePhase,
} from '../../utils/roleplayBlocks'
import { splitMentionSegments } from '../../utils/mentionHighlight'

/** 消息内嵌 <audio> 播放器（白名单 http/https） */
function MarkdownAudio({ src }: { src?: string }) {
  if (!src) return null
  return (
    <audio
      controls
      loop
      preload="none"
      src={src}
      style={{ width: '100%', maxWidth: 320, height: 44, margin: '4px 0' }}
    />
  )
}

const markdownComponents = { img: MarkdownImage, a: MarkdownLink, audio: MarkdownAudio }

/** 行内 Markdown 子集：粗体/斜体/删除线/行内代码/链接/换行（无原始 HTML） */
function InlineMarkdown({ text, mentionNames }: { text: string; mentionNames?: string[] }) {
  if (!text) return null
  const plugins: NonNullable<import('react-markdown').Options['remarkPlugins']> = [remarkGfm]
  if (mentionNames && mentionNames.length > 0) {
    plugins.push([remarkMentionHighlight, mentionNames])
  }
  return (
    <ReactMarkdown
      remarkPlugins={plugins}
      components={{
        // 行内场景避免 p 嵌套 p
        p: ({ children }) => <>{children}</>,
        li: ({ children }) => <>{children}</>,
        a: MarkdownLink,
      }}
    >
      {text}
    </ReactMarkdown>
  )
}

function withMentions(
  text: string,
  mentionNames: string[] | undefined,
  keyPrefix: string,
): React.ReactNode {
  if (!mentionNames?.length || !text) return text
  const segments = splitMentionSegments(text, mentionNames)
  if (!segments.some((s) => s.mention)) return text
  return segments.map((segment, index) =>
    segment.mention ? (
      <span key={`${keyPrefix}-${index}`} className="mention-highlight">
        {segment.text}
      </span>
    ) : (
      <React.Fragment key={`${keyPrefix}-${index}`}>{segment.text}</React.Fragment>
    ),
  )
}

export interface RoleplayContentRendererProps {
  content: string
  /** blocks 走语义分块；markdown / 缺省走兼容 Markdown 管线 */
  contentRenderMode?: 'markdown' | 'blocks' | undefined
  /** 当前是否处于流式（影响 complete 标记与 class） */
  isStreaming?: boolean
  /** 需要高亮的 @角色名 */
  mentionNames?: string[]
  /** 空内容占位 */
  emptyFallback?: React.ReactNode
  className?: string
  /** 图片点击放大 */
  onImageClick?: (src: string) => void
  /** 流式打字光标 class */
  streamingClassName?: string
  /** Markdown 路径是否启用 remark-roleplay 语义增强 */
  enableRoleplayRemark?: boolean
}

/**
 * 统一正文渲染：单聊 / 群聊共用。
 * - contentRenderMode === 'blocks' → parseRoleplayBlocks 语义块
 * - 否则（历史消息/开场白）→ ReactMarkdown 兼容路径
 * 不负责头像、时间、操作菜单、翻译按钮等外围 UI。
 */
export function RoleplayContentRenderer({
  content,
  contentRenderMode,
  isStreaming = false,
  mentionNames,
  emptyFallback = null,
  className,
  onImageClick,
  streamingClassName,
  enableRoleplayRemark = true,
}: RoleplayContentRendererProps) {
  const useBlocks = contentRenderMode === 'blocks'
  const phase: RoleplayParsePhase = isStreaming ? 'streaming' : 'final'

  const semanticBlocks = useMemo(
    () => (useBlocks ? parseRoleplayBlocks(content || '', { phase }) : null),
    [useBlocks, content, phase],
  )

  const mentionHighlightPlugins = useMemo(() => {
    if (useBlocks || !mentionNames || mentionNames.length === 0) return []
    return [[remarkMentionHighlight, mentionNames]] as NonNullable<
      import('react-markdown').Options['remarkPlugins']
    >
  }, [useBlocks, mentionNames])

  if (useBlocks) {
    if (!semanticBlocks || semanticBlocks.length === 0) {
      return <div className={cn('markdown-body', className)}>{emptyFallback}</div>
    }
    return (
      <div className={cn('markdown-body roleplay-blocks', className)} data-roleplay-blocks="true">
        <div className="space-y-2">
          {semanticBlocks.map((block, index) => {
            const incomplete = block.kind === 'dialogue' && block.complete === false
            const blockClass = cn(
              'whitespace-pre-wrap select-text',
              block.kind === 'dialogue' && 'dialogue-block',
              block.kind === 'narration' && 'action-block',
              incomplete && 'is-incomplete is-streaming',
            )
            return (
              <p key={index} className={blockClass} data-block-kind={block.kind}>
                {block.kind === 'dialogue' && (
                  <>
                    {block.speaker && (
                      <span className="dialogue-speaker">
                        {withMentions(block.speaker, mentionNames, `sp-${index}`)}
                      </span>
                    )}
                    <span className="dialogue-text">
                      <InlineMarkdown
                        text={block.complete === false ? block.text : stripOuterQuotes(block.text)}
                        mentionNames={mentionNames}
                      />
                    </span>
                  </>
                )}
                {block.kind === 'thought' && (
                  <span className="italic text-tavern-text-muted">{block.text}</span>
                )}
                {block.kind === 'narration' && (
                  <InlineMarkdown text={block.text} mentionNames={mentionNames} />
                )}
                {block.kind === 'mixed' && (
                  <>
                    {splitQuoteSegments(block.text).map((seg, segIndex) =>
                      seg.quoted ? (
                        <span key={segIndex} className="dialogue-inline">
                          <InlineMarkdown text={seg.text} mentionNames={mentionNames} />
                        </span>
                      ) : (
                        <React.Fragment key={segIndex}>
                          <InlineMarkdown text={seg.text} mentionNames={mentionNames} />
                        </React.Fragment>
                      ),
                    )}
                  </>
                )}
              </p>
            )
          })}
        </div>
      </div>
    )
  }

  // Markdown 兼容路径（历史消息 / 开场白）
  return (
    <div
      className={cn(
        'markdown-body',
        streamingClassName && isStreaming && streamingClassName,
        className,
      )}
      onClick={
        onImageClick
          ? (e: React.MouseEvent) => {
              const target = e.target as HTMLElement
              if (target.tagName === 'IMG' && (target as HTMLImageElement).src) {
                onImageClick((target as HTMLImageElement).src)
              }
            }
          : undefined
      }
    >
      <ReactMarkdown
        remarkPlugins={[
          remarkGfm,
          ...(enableRoleplayRemark ? [remarkRoleplay] : []),
          remarkAudio,
          ...mentionHighlightPlugins,
        ]}
        rehypePlugins={[rehypeHighlight]}
        components={markdownComponents}
      >
        {content || ''}
      </ReactMarkdown>
      {!content && emptyFallback}
    </div>
  )
}
