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

interface ContinueSliderOption<T extends string> {
  value: T
  label: string
  description: string
}

function ContinueSliderControl<T extends string>({
  title,
  icon,
  ariaLabel,
  options,
  value,
  onChange,
}: {
  title: string
  icon: ReactNode
  ariaLabel: string
  options: ReadonlyArray<ContinueSliderOption<T>>
  value: T
  onChange: (value: T) => void
}) {
  const index = Math.max(options.findIndex((option) => option.value === value), 0)
  const ratio = index / Math.max(options.length - 1, 1)
  const activeOption = options[index] ?? options[0]
  const progress = `${ratio * 100}%`
  const thumbPosition = `calc(7px + (100% - 14px) * ${ratio})`

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

      <div className="mt-2.5 px-1">
        <div className="group relative h-[18px]">
          <span className="pointer-events-none absolute inset-x-[7px] top-1/2 h-1 -translate-y-1/2 overflow-hidden rounded-full bg-tavern-bg-hover" aria-hidden>
            <span
              className="block h-full rounded-full bg-tavern-accent transition-[width] duration-200"
              style={{ width: progress }}
            />
          </span>
          <span
            className="pointer-events-none absolute top-1/2 h-6 w-6 -translate-x-1/2 -translate-y-1/2 rounded-full bg-tavern-accent-soft opacity-0 transition-opacity group-focus-within:opacity-100"
            style={{ left: thumbPosition }}
            aria-hidden
          />
          <span
            className="pointer-events-none absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-tavern-accent shadow-[0_0_0_3px_var(--tavern-bg-card),0_0_0_4px_var(--color-accent),0_3px_8px_rgba(26,22,37,0.24)] transition-[left,transform] duration-200 group-hover:scale-110"
            style={{ left: thumbPosition }}
            aria-hidden
          />
          <input
            type="range"
            min={0}
            max={options.length - 1}
            step={1}
            value={index}
            onChange={(event) => {
              const option = options[Number(event.target.value)]
              if (option) onChange(option.value)
            }}
            className="absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0"
            aria-label={ariaLabel}
            aria-valuetext={activeOption?.label}
          />
        </div>
      </div>

      <div className="mt-1.5 grid grid-cols-4 gap-1">
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
              <div className="absolute bottom-full left-0 mb-2 w-48 rounded-lg border border-tavern-border bg-tavern-bg-soft shadow-lg z-50 overflow-hidden">
                {[
                  { label: '当前场景', desc: '自动分析对话上下文', cmd: '/imagine' },
                  { label: '角色肖像', desc: '角色全身外观', cmd: '/imagine --mode character' },
                  { label: '面部特写', desc: '角色面部细节', cmd: '/imagine --mode face' },
                  { label: '场景背景', desc: '当前场景环境', cmd: '/imagine --mode background' },
                  { label: '自定义描述...', desc: '手动输入提示词', cmd: '/imagine ' },
                ].map((item) => (
                  <button
                    key={item.label}
                    className="w-full px-3 py-2 text-left hover:bg-tavern-bg-hover transition-colors border-b border-tavern-border-soft last:border-0"
                    onClick={() => {
                      setText(item.cmd)
                      setImageMenuOpen(false)
                      setTimeout(() => textareaRef.current?.focus(), 0)
                    }}
                  >
                    <div className="text-sm text-tavern-text">{item.label}</div>
                    <div className="text-[11px] text-tavern-text-muted">{item.desc}</div>
                  </button>
                ))}
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
                      <ContinueSliderControl
                        title="最终输入框内容长度"
                        icon={<AlignLeft className="h-3.5 w-3.5" aria-hidden />}
                        ariaLabel="最终输入框内容长度"
                        options={CONTINUE_LENGTH_OPTIONS}
                        value={continueLength}
                        onChange={(value) => updateSettings({ continueLength: value })}
                      />
                      <div className="my-3 border-t border-tavern-border-soft" />
                      <ContinueSliderControl
                        title="剧情转折强度"
                        icon={<Zap className="h-3.5 w-3.5" aria-hidden />}
                        ariaLabel="剧情转折强度"
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
