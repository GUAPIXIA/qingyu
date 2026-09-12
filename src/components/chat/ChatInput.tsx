import { useState, type ReactNode } from 'react'
import { Send, Square, ImagePlus, X, Sparkles, Loader2, Undo2, Wand2, Reply, SlidersHorizontal, AlignLeft, Zap } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useChatInputState } from './useChatInputState'
import { useSettingsStore } from '../../store/useSettingsStore'
import { CONTINUE_INTENSITY_OPTIONS, CONTINUE_LENGTH_OPTIONS, resolveContinueIntensity, resolveContinueLength } from '../../../shared/continueIntensity'
import type { Character, Message } from '../../../shared/types'

interface ChatInputProps {
  character: Character
  disabled?: boolean
  /** 引用回复：被引用消息（P1-5） */
  replyTo?: Message | null
  onCancelReply?: () => void
}

type ImageSelfMode = 'hidden' | 'silhouette' | 'translucent' | 'pov'

const IMAGE_SCENE_OPTIONS = [
  { value: 'moment', label: '剧情瞬间', desc: '还原最新动作与情绪' },
  { value: 'closeup', label: '对方近景', desc: '神态、视线与手势' },
  { value: 'full', label: '对方全身', desc: '姿势、动作与穿着' },
  { value: 'interaction', label: '互动构图', desc: '对方清晰，我方弱化' },
  { value: 'background', label: '环境空镜', desc: '只表现地点与氛围' },
] as const

const IMAGE_SELF_OPTIONS: ReadonlyArray<{
  value: ImageSelfMode
  label: string
  desc: string
}> = [
  { value: 'hidden', label: '不出现', desc: '只画对方' },
  { value: 'silhouette', label: '仅轮廓', desc: '前景虚焦' },
  { value: 'translucent', label: '半透明', desc: '边缘陪衬' },
  { value: 'pov', label: '第一人称', desc: '最多露手' },
]

interface ContinueOption<T extends string> {
  value: T
  label: string
  description: string
}

/**
 * 续写控制项：四个离散档位，只用分段按钮。
 * 隐藏滑块与档位按钮表达同一组离散值，保留滑块只会多出一层不可见热区与重复的
 * 键盘/读屏路径（方案 §6.3），因此这里不再渲染 input[type=range]。
 */
function ContinueTierControl<T extends string>({
  title,
  icon,
  options,
  value,
  onChange,
}: {
  title: string
  icon: ReactNode
  options: ReadonlyArray<ContinueOption<T>>
  value: T
  onChange: (value: T) => void
}) {
  const activeOption = options.find((option) => option.value === value) ?? options[0]

  return (
    <section>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 text-[11px] font-semibold text-tavern-text">
          <span className="grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-tavern-accent-soft text-tavern-accent">
            {icon}
          </span>
          <span>{title}</span>
        </div>
        <span className="shrink-0 rounded-full border border-tavern-accent/20 bg-tavern-accent-soft px-2 py-0.5 text-[10px] font-semibold text-tavern-accent">
          {activeOption?.label}
        </span>
      </div>

      <div className="mt-2.5 grid grid-cols-4 gap-1">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            aria-pressed={option.value === value}
            className={cn(
              'rounded-lg px-1 py-1.5 text-[10px] whitespace-nowrap transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tavern-accent/40',
              option.value === value
                ? 'bg-tavern-accent-soft text-tavern-accent font-semibold'
                : 'text-tavern-text-soft/70 hover:bg-tavern-bg-soft hover:text-tavern-text',
            )}
          >
            {option.label}
          </button>
        ))}
      </div>

      <p className="mt-1.5 min-h-[17px] px-1 text-[10px] leading-[1.55] text-tavern-text-muted">
        {activeOption?.description}
      </p>
    </section>
  )
}

/**
 * 聊天输入框（渲染层）
 * 全部状态与逻辑见 useChatInputState（输入 / 草稿 / 命令 / 快捷回复 / AI 辅助）。
 */
export function ChatInput({ character, disabled, replyTo, onCancelReply }: ChatInputProps) {
  const {
    text, setText, images, isAiProcessing, originalText, setOriginalText,
    commandSuggestions, selectedSuggestionIdx, setCommandSuggestions, imageMenuOpen, setImageMenuOpen,
    notification, textareaRef, effectiveReplies, isConnected, isStreaming, stopStreaming,
    runQuickReply, handleSend, handleKeyDown, handleImageSelect, removeImage,
    handleAiContinue, handleAiPolish, settings,
  } = useChatInputState(character, replyTo, onCancelReply)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const [continueMenuOpen, setContinueMenuOpen] = useState(false)
  const [imageSelfMode, setImageSelfMode] = useState<ImageSelfMode>('hidden')
  const continueLength = resolveContinueLength(settings.continueLength)
  const continueIntensity = resolveContinueIntensity(settings.continueIntensity)
  const lengthOption = CONTINUE_LENGTH_OPTIONS.find((option) => option.value === continueLength) ?? CONTINUE_LENGTH_OPTIONS[1]
  const intensityIndex = CONTINUE_INTENSITY_OPTIONS.findIndex((o) => o.value === continueIntensity)
  const intensityOption = CONTINUE_INTENSITY_OPTIONS[intensityIndex] ?? CONTINUE_INTENSITY_OPTIONS[2]

  return (
    <div className="border-t border-tavern-border-soft bg-tavern-bg-soft px-4 py-3">
      {/* 图片预览 */}
      {images.length > 0 && (
        <div className="flex gap-2 mb-2 flex-wrap">
          {images.map((img, i) => (
            // BUG-30 修复：key 使用图片内容而非数组索引，删除中间图片时 React 能正确识别元素
            <div key={img.slice(0, 64) || `img-${i}`} className="relative group">
              <img src={img} alt="" className="w-20 h-20 rounded-lg object-cover border border-tavern-border" />
              <button
                onClick={() => removeImage(i)}
                className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-tavern-danger text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 回退按钮 */}
      {originalText !== null && (
        <div className="flex items-center justify-between mb-2 px-1">
          <span className="text-xs text-tavern-text-muted flex items-center gap-1">
            <Sparkles className="w-3 h-3 text-tavern-accent" />
            已润色
          </span>
          <button
            onClick={() => {
              setText(originalText)
              setOriginalText(null)
            }}
            className="flex items-center gap-1 px-2 py-1 rounded text-xs text-tavern-text-soft bg-tavern-bg-card border border-tavern-border-soft hover:border-tavern-accent hover:text-tavern-accent transition-colors"
          >
            <Undo2 className="w-3 h-3" />
            回退原文
          </button>
        </div>
      )}

      {/* 引用回复预览条（P1-5） */}
      {replyTo && (
        <div className="mb-2 flex items-center gap-2 px-3 py-1.5 rounded-lg bg-tavern-bg-soft border border-tavern-border-soft">
          <Reply className="w-3.5 h-3.5 text-tavern-accent shrink-0" />
          <div className="min-w-0 flex-1 text-xs">
            <span className="text-tavern-accent font-medium">
              {replyTo.role === 'user' ? (settings.userName || '用户') : replyTo.role === 'system' ? '系统' : character.name}:
            </span>
            <span className="text-tavern-text-muted ml-1 truncate">
              {(replyTo.content || '').slice(0, 60)}
              {(replyTo.content || '').length > 60 ? '...' : ''}
            </span>
          </div>
          <button
            onClick={onCancelReply}
            className="p-0.5 rounded text-tavern-text-muted hover:text-tavern-danger transition-colors shrink-0"
            title="取消引用"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* 快捷回复按钮栏 */}
      {effectiveReplies.length > 0 && (
        <div className="flex items-center flex-wrap gap-1.5 mb-2 px-1">
          {effectiveReplies.map((qr) => (
            <button
              key={qr.id}
              onClick={() => runQuickReply(qr)}
              disabled={isStreaming}
              title={qr.action === 'text'
                ? (qr.sendWithAI ? '发送并触发 AI 回复' : '仅发送消息')
                : qr.action === 'preset' ? '切换预设' : '触发命令'}
              className="px-2.5 py-1 rounded-lg text-xs border border-tavern-border-soft bg-tavern-bg-card text-tavern-text-soft hover:text-tavern-accent hover:border-tavern-accent disabled:opacity-50 transition-colors flex items-center gap-1"
            >
              {qr.hotkey != null && (
                <span className="text-[10px] text-tavern-text-muted">Ctrl+{qr.hotkey}</span>
              )}
              <span className="truncate max-w-[10rem]">{qr.label}</span>
            </button>
          ))}
        </div>
      )}

      {/* 输入框 */}
      <div className="flex items-center gap-2">
        <button
          onClick={handleImageSelect}
          className="p-2 rounded-lg text-tavern-text-muted hover:text-tavern-text hover:bg-tavern-bg-hover transition-colors shrink-0"
          title="添加图片"
        >
          <ImagePlus className="w-5 h-5" />
        </button>

        <div className="relative shrink-0">
          <button
            onClick={() => setImageMenuOpen(v => !v)}
            className="p-2 rounded-lg text-tavern-text-muted hover:text-tavern-accent hover:bg-tavern-bg-hover transition-colors"
            title="AI 生图"
          >
            <Wand2 className="w-5 h-5" />
          </button>

          {imageMenuOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setImageMenuOpen(false)} />
              <div
                className="absolute bottom-full left-0 z-50 mb-2 w-[21rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-tavern-border bg-tavern-bg-card shadow-2xl shadow-black/25"
                role="dialog"
                aria-label="生图构图设置"
              >
                <div className="flex items-center justify-between border-b border-tavern-border-soft bg-tavern-bg-soft px-3.5 py-2.5">
                  <div>
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-tavern-text">
                      <Wand2 className="h-3.5 w-3.5 text-tavern-accent" />
                      镜头设计
                    </div>
                    <p className="mt-0.5 text-[10px] text-tavern-text-muted">对方始终是画面主体</p>
                  </div>
                  <span className="rounded-full bg-tavern-accent-soft px-2 py-0.5 text-[9px] font-semibold tracking-wide text-tavern-accent">
                    SCENE
                  </span>
                </div>

                <div className="space-y-3 p-3">
                  <section>
                    <div className="mb-1.5 flex items-center justify-between px-0.5">
                      <span className="text-[10px] font-semibold tracking-wide text-tavern-text-soft">画面重点</span>
                      <span className="text-[9px] text-tavern-text-muted">选择后填入输入框</span>
                    </div>
                    <div className="grid grid-cols-2 gap-1.5">
                      {IMAGE_SCENE_OPTIONS.map((item, index) => (
                        <button
                          key={item.value}
                          type="button"
                          className={cn(
                            'group rounded-xl border border-tavern-border-soft bg-tavern-bg-soft px-2.5 py-2 text-left transition-all hover:-translate-y-px hover:border-tavern-accent/55 hover:bg-tavern-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tavern-accent/40',
                            index === IMAGE_SCENE_OPTIONS.length - 1 && 'col-span-2',
                          )}
                          onClick={() => {
                            const selectedSelf = item.value === 'background' ? 'hidden' : imageSelfMode
                            setText(`/imagine --mode ${item.value} --self ${selectedSelf}`)
                            setImageMenuOpen(false)
                            setTimeout(() => textareaRef.current?.focus(), 0)
                          }}
                        >
                          <span className="block text-[11px] font-semibold text-tavern-text group-hover:text-tavern-accent">{item.label}</span>
                          <span className="mt-0.5 block text-[9px] leading-4 text-tavern-text-muted">{item.desc}</span>
                        </button>
                      ))}
                    </div>
                  </section>

                  <section className="rounded-xl border border-tavern-border-soft bg-tavern-bg-soft p-2">
                    <div className="mb-1.5 flex items-center justify-between px-0.5">
                      <span className="text-[10px] font-semibold tracking-wide text-tavern-text-soft">我方入镜</span>
                      <span className="text-[9px] text-tavern-text-muted">默认不出现</span>
                    </div>
                    <div className="grid grid-cols-4 gap-1">
                      {IMAGE_SELF_OPTIONS.map((item) => (
                        <button
                          key={item.value}
                          type="button"
                          aria-label={item.label}
                          aria-pressed={imageSelfMode === item.value}
                          onClick={() => setImageSelfMode(item.value)}
                          className={cn(
                            'rounded-lg px-1 py-1.5 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tavern-accent/40',
                            imageSelfMode === item.value
                              ? 'bg-tavern-accent-soft text-tavern-accent'
                              : 'text-tavern-text-muted hover:bg-tavern-bg-hover hover:text-tavern-text',
                          )}
                        >
                          <span className="block text-[10px] font-semibold">{item.label}</span>
                          <span className="mt-0.5 block text-[8px] opacity-70">{item.desc}</span>
                        </button>
                      ))}
                    </div>
                  </section>

                  <button
                    type="button"
                    className="flex w-full items-center justify-between rounded-xl border border-dashed border-tavern-border px-3 py-2 text-left transition-colors hover:border-tavern-accent/60 hover:bg-tavern-accent-soft"
                    onClick={() => {
                      const command = '/imagine '
                      setText(command)
                      setImageMenuOpen(false)
                      // 等 React 把受控值写入 textarea 后再聚焦并移动选区；仅 focus
                      // 会保留上一次的光标位置，导致用户从命令开头开始输入。
                      requestAnimationFrame(() => {
                        const input = textareaRef.current
                        input?.focus()
                        input?.setSelectionRange(command.length, command.length)
                      })
                    }}
                  >
                    <span className="text-[11px] font-semibold text-tavern-text">自定义描述</span>
                    <span className="text-[9px] text-tavern-text-muted">直接输入自己的提示词 →</span>
                  </button>
                </div>
              </div>
            </>
          )}
        </div>

        <div className="flex-1 relative">
          {/* 命令补全下拉 */}
          {commandSuggestions.length > 0 && (
            <div className="absolute bottom-full left-0 mb-2 max-w-md max-h-60 overflow-y-auto rounded-lg border border-tavern-border bg-tavern-bg-soft shadow-lg z-50">
              {commandSuggestions.map((s, i) => (
                <button
                  key={s.name}
                  className={cn(
                    'w-full px-3 py-2 text-left text-sm hover:bg-tavern-bg-hover flex items-center gap-2',
                    i === selectedSuggestionIdx && 'bg-tavern-bg-hover'
                  )}
                  onClick={() => {
                    if (!text.includes(' ')) {
                      setText('/' + s.name + ' ')
                    } else {
                      const parts = text.split(' ')
                      parts[parts.length - 1] = s.name
                      setText(parts.join(' ') + ' ')
                    }
                    setCommandSuggestions([])
                    textareaRef.current?.focus()
                  }}
                >
                  <span className="font-mono text-tavern-accent">
                    {text.includes(' ') ? s.name : '/' + s.name}
                  </span>
                  {s.description && (
                    <span className="text-xs text-tavern-text-muted truncate">{s.description}</span>
                  )}
                </button>
              ))}
              <div className="px-3 py-1 text-[10px] text-tavern-text-muted border-t border-tavern-border-soft">
                Tab 补全 · ↑↓ 选择 · Esc 关闭
              </div>
            </div>
          )}
          {/* 通知提示 */}
          {notification && (
            <div className="absolute bottom-full left-0 mb-2 px-3 py-1.5 rounded-lg bg-tavern-accent text-white text-xs shadow-lg z-50 animate-fade-in">
              {notification}
            </div>
          )}
          <textarea
            ref={textareaRef as React.Ref<HTMLTextAreaElement>}
            autoFocus
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              if (originalText !== null && e.target.value !== originalText) {
                setOriginalText(null)
              }
            }}
            onKeyDown={handleKeyDown}
            placeholder={
              !isConnected
                ? '请先在设置中配置 API 连接...'
                : isStreaming
                ? '正在生成回复...'
                : '输入消息，Enter 发送，Shift+Enter 换行'
            }
            disabled={disabled || isStreaming}
            rows={1}
            className="textarea w-full resize-none py-2.5 pr-3 leading-relaxed"
            style={{ minHeight: '42px', maxHeight: '200px' }}
          />
        </div>

        {/* AI 辅助按钮 */}
        {!isStreaming && (
          <div className="flex items-center gap-1 shrink-0">
            <div className="relative flex items-center">
              <button
                onClick={handleAiContinue}
                disabled={isAiProcessing}
                className={cn(
                  'h-[30px] px-2.5 rounded-l-lg border border-r-0 text-xs transition-colors flex items-center gap-1',
                  isAiProcessing
                    ? 'border-tavern-border-soft bg-tavern-bg-card text-tavern-text-muted cursor-not-allowed'
                    : 'border-tavern-border-soft bg-tavern-bg-card text-tavern-text-soft hover:text-tavern-accent hover:border-tavern-accent hover:border-r-0'
                )}
                title="AI 根据上下文续写输入文字"
              >
                {isAiProcessing ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <Sparkles className="w-3 h-3" />
                )}
                续写
              </button>
              <button
                onClick={() => setContinueMenuOpen((v) => !v)}
                disabled={isAiProcessing}
                aria-label="续写设置"
                aria-expanded={continueMenuOpen}
                aria-controls="continue-settings-menu"
                className={cn(
                  'relative z-50 h-[30px] px-1.5 rounded-r-lg border text-xs transition-all inline-flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tavern-accent/40',
                  continueMenuOpen
                    ? 'border-tavern-accent bg-tavern-accent-soft text-tavern-accent shadow-sm'
                    : 'border-tavern-border-soft bg-tavern-bg-card text-tavern-text-muted hover:text-tavern-accent hover:border-tavern-accent',
                )}
                title={`续写设置：${lengthOption.label} · ${intensityOption.label}`}
              >
                <SlidersHorizontal className="w-3 h-3" />
              </button>

              {continueMenuOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setContinueMenuOpen(false)} />
                  <div
                    id="continue-settings-menu"
                    role="dialog"
                    aria-label="续写设置"
                    className="absolute bottom-full right-0 z-50 mb-3 w-80 rounded-2xl border border-tavern-border-soft bg-tavern-bg-card p-4 shadow-[0_18px_48px_rgba(26,22,37,0.18),0_3px_12px_rgba(26,22,37,0.08)] animate-fade-in"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <span className="absolute -bottom-1.5 right-2.5 h-3 w-3 rotate-45 border-b border-r border-tavern-border-soft bg-tavern-bg-card" aria-hidden />

                    <div className="flex items-center gap-2.5">
                      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-tavern-accent-soft text-tavern-accent">
                        <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden />
                      </span>
                      <div>
                        <p className="text-xs font-semibold text-tavern-text">续写设置</p>
                        <p className="mt-0.5 text-[10px] text-tavern-text-soft/70">篇幅与剧情变化分别控制</p>
                      </div>
                    </div>

                    <div className="mt-3.5 rounded-xl border border-tavern-border-soft bg-tavern-bg-soft/45 p-3">
                      <ContinueTierControl
                        title="本次续写长度"
                        icon={<AlignLeft className="h-3.5 w-3.5" aria-hidden />}
                        options={CONTINUE_LENGTH_OPTIONS}
                        value={continueLength}
                        onChange={(value) => updateSettings({ continueLength: value })}
                      />
                      <div className="my-3 border-t border-tavern-border-soft" />
                      <ContinueTierControl
                        title="剧情变化"
                        icon={<Zap className="h-3.5 w-3.5" aria-hidden />}
                        options={CONTINUE_INTENSITY_OPTIONS}
                        value={continueIntensity}
                        onChange={(value) => updateSettings({ continueIntensity: value })}
                      />
                    </div>
                  </div>
                </>
              )}
            </div>
            {text.trim().length > 0 && (
              <button
                onClick={handleAiPolish}
                disabled={isAiProcessing}
                className={cn(
                  'px-2.5 py-1.5 rounded-lg text-xs border transition-colors flex items-center gap-1',
                  isAiProcessing
                    ? 'border-tavern-border-soft bg-tavern-bg-card text-tavern-text-muted cursor-not-allowed'
                    : 'border-tavern-border-soft bg-tavern-bg-card text-tavern-text-soft hover:text-tavern-accent hover:border-tavern-accent'
                )}
                title="AI 润色输入文字"
              >
                {isAiProcessing ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <Sparkles className="w-3 h-3" />
                )}
                润色
              </button>
            )}
          </div>
        )}

        {isStreaming ? (
          <button
            onClick={stopStreaming}
            className="p-2.5 rounded-lg bg-tavern-danger text-white hover:opacity-90 transition-opacity shrink-0"
            title="停止生成"
          >
            <Square className="w-5 h-5" fill="currentColor" />
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={!text.trim() || !isConnected}
            className={cn(
              'p-2.5 rounded-lg transition-all shrink-0',
              text.trim() && isConnected
                ? 'btn-primary'
                : 'bg-tavern-bg-card text-tavern-text-muted cursor-not-allowed'
            )}
            title="发送"
          >
            <Send className="w-5 h-5" />
          </button>
        )}
      </div>
    </div>
  )
}
