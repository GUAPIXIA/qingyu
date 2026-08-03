import { X, Languages, Loader2 } from 'lucide-react'
import type { Character } from '../../../../shared/types'
import type { TaAutoSize, TranslateProps, EditorSectionProps } from './types'

interface AdvancedSectionProps extends EditorSectionProps, TranslateProps {
  taDesc: TaAutoSize
  taSysprompt: TaAutoSize
  taFirstmsg: TaAutoSize
}

/** 高级选项区块(描述 / 系统提示 / 开场白) */
export function AdvancedSection(props: AdvancedSectionProps) {
  const {
    form, update,
    taDesc, taSysprompt, taFirstmsg,
    translatedFields, translatingField, handleTranslateField, handleTranslateGreeting,
  } = props
  return (
    <div className="space-y-4">
        {/* 角色描述（一般内容较多，置于右栏顶部） */}
        <div className="field-card">
          <label className="label">
            角色描述
            {(translatedFields.has('description') || form.translatedContent?.description) && (
              <span className="text-xs text-tavern-accent ml-1">(已翻译)</span>
            )}
            <button
              className="ml-2 p-0.5 rounded text-tavern-text-muted hover:text-tavern-accent hover:bg-tavern-accent-soft transition-colors align-middle"
              onClick={() => handleTranslateField('description')}
              disabled={translatingField === 'description' || !form.description}
              title="AI 翻译此字段"
            >
              {translatingField === 'description' ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Languages className="w-3.5 h-3.5" />
              )}
            </button>
          </label>
          <textarea
            ref={taDesc.ref}
            style={taDesc.style}
            className="textarea min-h-[120px] resize-y"
            value={form.description}
            onChange={(e) => update({ description: e.target.value })}
            placeholder="描述角色的外貌、身份、背景等基本信息"
          />
          {form.translatedContent?.description && (
            <div className="mt-1.5 pl-2 border-l-2 border-tavern-accent">
              <div className="flex items-center gap-1">
                <span className="text-xs text-tavern-accent font-medium">翻译：</span>
                <button
                  className="p-0.5 rounded text-tavern-text-muted hover:text-tavern-danger transition-colors"
                  onClick={() => {
                    const tc = { ...form.translatedContent }
                    delete tc.description
                    update({ translatedContent: tc } as Partial<Character>)
                  }}
                  title="清除翻译"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
              <p className="text-xs text-tavern-text-soft mt-0.5 whitespace-pre-wrap">
                {form.translatedContent.description}
              </p>
            </div>
          )}
        </div>

        {/* 角色系统提示词（覆盖预设） */}
        <div className="field-card">
          <label className="label">角色系统提示词（覆盖预设）</label>
          <textarea
            ref={taSysprompt.ref}
            style={taSysprompt.style}
            className="textarea min-h-[80px] resize-y"
            value={form.systemPrompt || ''}
            onChange={(e) => update({ systemPrompt: e.target.value })}
            placeholder="为这个角色设定专属的系统提示词，留空则使用预设中的系统提示词"
          />
          <p className="text-xs text-tavern-text-muted mt-1">留空则使用预设中的系统提示词</p>
        </div>

        {/* 分组：对话开场 */}
            <div className="flex items-center gap-2 pt-1">
              <span className="text-[11px] font-semibold text-tavern-accent tracking-wider px-2 py-0.5 rounded-md bg-tavern-accent-soft">对话开场</span>
              <div className="flex-1 h-px bg-tavern-border-soft" />
            </div>

            {/* 首条消息 */}
            <div className="field-card">
              <label className="label">
                首条消息
                {(translatedFields.has('firstMessage') || form.translatedContent?.firstMessage) && (
                  <span className="text-xs text-tavern-accent ml-1">(已翻译)</span>
                )}
                <button
                  className="ml-2 p-0.5 rounded text-tavern-text-muted hover:text-tavern-accent hover:bg-tavern-accent-soft transition-colors align-middle"
                  onClick={() => handleTranslateField('firstMessage')}
                  disabled={translatingField === 'firstMessage' || !form.firstMessage}
                  title="AI 翻译此字段"
                >
                  {translatingField === 'firstMessage' ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Languages className="w-3.5 h-3.5" />
                  )}
                </button>
              </label>
              <textarea
                ref={taFirstmsg.ref}
                style={taFirstmsg.style}
                className="textarea min-h-[120px] resize-y"
                value={form.firstMessage}
                onChange={(e) => update({ firstMessage: e.target.value })}
                placeholder="角色发送的第一条消息，用于开启对话"
              />
              {form.translatedContent?.firstMessage && (
                <div className="mt-1.5 pl-2 border-l-2 border-tavern-accent">
                  <div className="flex items-center gap-1">
                    <span className="text-xs text-tavern-accent font-medium">翻译：</span>
                    <button
                      className="p-0.5 rounded text-tavern-text-muted hover:text-tavern-danger transition-colors"
                      onClick={() => {
                        const tc = { ...form.translatedContent }
                        delete tc.firstMessage
                        update({ translatedContent: tc } as Partial<Character>)
                      }}
                      title="清除翻译（保留原文）"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                  <p className="text-xs text-tavern-text-soft mt-0.5 whitespace-pre-wrap">
                    {form.translatedContent.firstMessage}
                  </p>
                </div>
              )}
            </div>

            {/* 备选开场白 */}
            <div className="field-card">
              <label className="label">备选开场白</label>
              <div className="space-y-2">
                {(form.alternateGreetings || []).map((g, i) => (
                  <div key={i}>
                    <div className="flex gap-2">
                    <textarea
                      className="textarea min-h-[60px] resize-y flex-1 text-sm"
                      value={g}
                      onChange={(e) => {
                        const updated = [...(form.alternateGreetings || [])]
                        updated[i] = e.target.value
                        update({ alternateGreetings: updated })
                      }}
                      placeholder="备选的开场问候语"
                    />
                    <div className="flex flex-col gap-1 self-start shrink-0">
                      <button
                        className="btn-ghost p-1.5 text-tavern-text-muted hover:text-tavern-accent"
                        onClick={() => handleTranslateGreeting(i)}
                        disabled={translatingField === `greeting-${i}` || !g.trim()}
                        title="AI 翻译"
                      >
                        {translatingField === `greeting-${i}` ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Languages className="w-3.5 h-3.5" />
                        )}
                      </button>
                      <button
                        className="btn-ghost p-1.5 text-tavern-danger"
                        onClick={() => {
                          const updated = (form.alternateGreetings || []).filter((_, j) => j !== i)
                          update({ alternateGreetings: updated })
                          // 同步移除对应译文，保持索引对齐
                          const tc = { ...(form.translatedContent || {}) }
                          if (tc.alternateGreetings) {
                            tc.alternateGreetings = tc.alternateGreetings.filter((_, j) => j !== i)
                            update({ translatedContent: tc } as Partial<Character>)
                          }
                        }}
                        title="删除"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                  {form.translatedContent?.alternateGreetings?.[i] && (
                    <div className="mt-1 pl-2 border-l-2 border-tavern-accent ml-10">
                      <div className="flex items-center gap-1">
                        <span className="text-xs text-tavern-accent font-medium">翻译：</span>
                        <button
                          className="p-0.5 rounded text-tavern-text-muted hover:text-tavern-danger transition-colors"
                          onClick={() => {
                            const tc = { ...(form.translatedContent || {}) }
                            const translated = [...(tc.alternateGreetings || [])]
                            translated[i] = ''
                            tc.alternateGreetings = translated
                            update({ translatedContent: tc } as Partial<Character>)
                          }}
                          title="清除翻译（保留原文）"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                      <p className="text-xs text-tavern-text-soft mt-0.5 whitespace-pre-wrap">
                        {form.translatedContent.alternateGreetings[i]}
                      </p>
                    </div>
                  )}
                  </div>
                ))}
                <button
                  className="btn-ghost text-sm text-tavern-accent"
                  onClick={() => update({ alternateGreetings: [...(form.alternateGreetings || []), ''] })}
                >
                  + 添加备选开场白
                </button>
              </div>
            </div>

        </div>
  )
}
