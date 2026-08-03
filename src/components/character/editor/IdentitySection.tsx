import { ImagePlus, X, Languages, Loader2, RefreshCw } from 'lucide-react'
import { charAssetUrl } from '../../../utils/asset'
import type { Character } from '../../../../shared/types'
import type { TaAutoSize, TranslateProps, EditorSectionProps } from './types'
import { PresetBinding, LorebookBinding } from './Bindings'

interface IdentitySectionProps extends EditorSectionProps, TranslateProps {
  tagInput: string
  setTagInput: (v: string) => void
  handleAddTag: () => void
  handleRemoveTag: (tag: string) => void
  handleImageSelect: () => void
  handleReloadCover: () => void
  handleBackgroundSelect: () => void
  coverReloading: boolean
  coverError: string | null
  avatarError: boolean
  setAvatarError: (v: boolean) => void
  taPersonality: TaAutoSize
  taScenario: TaAutoSize
  taPosthist: TaAutoSize
  taExdialog: TaAutoSize
}

/** 头像 / 名字 / 标签 / 性格 + 短字段（场景 / 绑定 / 创作者 / 背景）区块 */
export function IdentitySection(props: IdentitySectionProps) {
  const {
    form, update, tagInput, setTagInput, handleAddTag, handleRemoveTag,
    handleImageSelect, handleReloadCover, handleBackgroundSelect, coverReloading, coverError,
    avatarError, setAvatarError, taPersonality, taScenario, taPosthist, taExdialog,
    translatedFields, translatingField, handleTranslateField,
  } = props
  return (
    <>
        {/* 头像和名字 */}
        <div className="field-card flex gap-4">
          <div className="shrink-0">
            <div
              className="w-24 h-24 rounded-2xl overflow-hidden bg-tavern-bg-hover border border-tavern-border cursor-pointer relative group"
              onClick={handleImageSelect}
            >
              {(form.avatar || (form.id ? charAssetUrl(form.id, 'avatar', form.updatedAt) : '')) && !avatarError ? (
                <img src={form.avatar || charAssetUrl(form.id, 'avatar', form.updatedAt)} alt="" className="w-full h-full object-cover" onError={() => setAvatarError(true)} />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-tavern-text-muted">
                  <ImagePlus className="w-8 h-8" />
                </div>
              )}
              <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                <span className="text-xs text-white">更换头像</span>
              </div>
            </div>
            {form._importImageUrl && !form.avatar && (
              <button
                className="btn-mini mt-2 w-full flex items-center justify-center gap-1"
                onClick={handleReloadCover}
                disabled={coverReloading}
              >
                {coverReloading ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <RefreshCw className="w-3 h-3" />
                )}
                重新加载封面
              </button>
            )}
            {coverError && (
              <p className="text-xs text-tavern-danger mt-1">{coverError}</p>
            )}
          </div>
          <div className="flex-1 space-y-3">
            <div>
              <label className="label">
                角色名 *
                {(translatedFields.has('name') || form.translatedContent?.name) && (
                  <span className="text-xs text-tavern-accent ml-1">(已翻译)</span>
                )}
                <button
                  className="ml-2 p-0.5 rounded text-tavern-text-muted hover:text-tavern-accent hover:bg-tavern-accent-soft transition-colors align-middle"
                  onClick={() => handleTranslateField('name')}
                  disabled={translatingField === 'name' || !form.name}
                  title="AI 翻译此字段"
                >
                  {translatingField === 'name' ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Languages className="w-3.5 h-3.5" />
                  )}
                </button>
              </label>
              <input
                className="input"
                value={form.name}
                onChange={(e) => update({ name: e.target.value })}
                placeholder="输入角色名"
              />
              {form.translatedContent?.name && form.translatedContent.name !== form.name && (
                <div className="mt-1.5 pl-2 border-l-2 border-tavern-accent">
                  <div className="flex items-center gap-1">
                    <span className="text-xs text-tavern-accent font-medium">翻译：</span>
                    <button
                      className="p-0.5 rounded text-tavern-text-muted hover:text-tavern-danger transition-colors"
                      onClick={() => {
                        const tc = { ...form.translatedContent }
                        delete tc.name
                        update({ translatedContent: tc } as Partial<Character>)
                      }}
                      title="清除翻译"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                  <p className="text-xs text-tavern-text-soft mt-0.5">
                    {form.translatedContent.name}
                  </p>
                </div>
              )}
            </div>
            <div>
              <label className="label">标签</label>
              <div className="flex flex-wrap gap-1.5 mb-1.5">
                {form.tags.map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-tavern-accent-soft text-tavern-accent"
                  >
                    {tag}
                    <button onClick={() => handleRemoveTag(tag)} className="hover:text-tavern-danger">
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
              <input
                className="input"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    handleAddTag()
                  }
                }}
                placeholder="输入标签后回车"
              />
            </div>
          </div>
        </div>

        {/* 性格 */}
        <div className="field-card">
          <label className="label">
            性格特征
            {(translatedFields.has('personality') || form.translatedContent?.personality) && (
              <span className="text-xs text-tavern-accent ml-1">(已翻译)</span>
            )}
            <button
              className="ml-2 p-0.5 rounded text-tavern-text-muted hover:text-tavern-accent hover:bg-tavern-accent-soft transition-colors align-middle"
              onClick={() => handleTranslateField('personality')}
              disabled={translatingField === 'personality' || !form.personality}
              title="AI 翻译此字段"
            >
              {translatingField === 'personality' ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Languages className="w-3.5 h-3.5" />
              )}
            </button>
          </label>
          <textarea
            ref={taPersonality.ref}
            style={taPersonality.style}
            className="textarea min-h-[80px] resize-y"
            value={form.personality}
            onChange={(e) => update({ personality: e.target.value })}
            placeholder="描述角色的性格特点、说话方式等"
          />
          {form.translatedContent?.personality && (
            <div className="mt-1.5 pl-2 border-l-2 border-tavern-accent">
              <div className="flex items-center gap-1">
                <span className="text-xs text-tavern-accent font-medium">翻译：</span>
                <button
                  className="p-0.5 rounded text-tavern-text-muted hover:text-tavern-danger transition-colors"
                  onClick={() => {
                    const tc = { ...form.translatedContent }
                    delete tc.personality
                    update({ translatedContent: tc } as Partial<Character>)
                  }}
                  title="清除翻译"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
              <p className="text-xs text-tavern-text-soft mt-0.5 whitespace-pre-wrap">
                {form.translatedContent.personality}
              </p>
            </div>
          )}
        </div>

        {/* 分组：场景与绑定 */}
        <div className="flex items-center gap-2 pt-1">
          <span className="text-[11px] font-semibold text-tavern-accent tracking-wider px-2 py-0.5 rounded-md bg-tavern-accent-soft">场景与绑定</span>
          <div className="flex-1 h-px bg-tavern-border-soft" />
        </div>

        {/* 场景设定 */}
        <div className="field-card">
          <label className="label">
            场景设定
            {(translatedFields.has('scenario') || form.translatedContent?.scenario) && (
              <span className="text-xs text-tavern-accent ml-1">(已翻译)</span>
            )}
            <button
              className="ml-2 p-0.5 rounded text-tavern-text-muted hover:text-tavern-accent hover:bg-tavern-accent-soft transition-colors align-middle"
              onClick={() => handleTranslateField('scenario')}
              disabled={translatingField === 'scenario' || !form.scenario}
              title="AI 翻译此字段"
            >
              {translatingField === 'scenario' ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Languages className="w-3.5 h-3.5" />
              )}
            </button>
          </label>
          <textarea
            ref={taScenario.ref}
            style={taScenario.style}
            className="textarea min-h-[80px] resize-y"
            value={form.scenario}
            onChange={(e) => update({ scenario: e.target.value })}
            placeholder="对话发生的场景和背景"
          />
          {form.translatedContent?.scenario && (
            <div className="mt-1.5 pl-2 border-l-2 border-tavern-accent">
              <div className="flex items-center gap-1">
                <span className="text-xs text-tavern-accent font-medium">翻译：</span>
                <button
                  className="p-0.5 rounded text-tavern-text-muted hover:text-tavern-danger transition-colors"
                  onClick={() => {
                    const tc = { ...form.translatedContent }
                    delete tc.scenario
                    update({ translatedContent: tc } as Partial<Character>)
                  }}
                  title="清除翻译"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
              <p className="text-xs text-tavern-text-soft mt-0.5 whitespace-pre-wrap">
                {form.translatedContent.scenario}
              </p>
            </div>
          )}
        </div>

        {/* 预设与世界书绑定 */}
        <div className="grid grid-cols-2 gap-4 field-card">
          <PresetBinding value={form.boundPresetId ?? null} onChange={(id) => update({ boundPresetId: id })} />
          <LorebookBinding value={form.boundLorebookIds ?? []} onChange={(ids) => update({ boundLorebookIds: ids })} />
        </div>

        {/* 分组：其他 */}
        <div className="flex items-center gap-2 pt-1">
          <span className="text-[11px] font-semibold text-tavern-accent tracking-wider px-2 py-0.5 rounded-md bg-tavern-accent-soft">其他</span>
          <div className="flex-1 h-px bg-tavern-border-soft" />
        </div>

        {/* 创作者 + 聊天背景 并排 */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="field-card">
            <label className="label">创作者</label>
            <input
              className="input"
              value={form.creator}
              onChange={(e) => update({ creator: e.target.value })}
              placeholder="角色卡作者"
            />
          </div>
          <div className="field-card">
            <label className="label">聊天背景</label>
            <div className="flex items-center gap-3">
              <div
                className="w-32 h-20 rounded-lg bg-tavern-bg-hover border border-tavern-border cursor-pointer overflow-hidden relative group shrink-0"
                onClick={handleBackgroundSelect}
              >
                {form.chatBackground ? (
                  <img src={form.chatBackground} className="w-full h-full object-cover" alt="" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-tavern-text-muted">
                    <ImagePlus className="w-6 h-6" />
                  </div>
                )}
                <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                  <span className="text-xs text-white">{form.chatBackground ? '更换背景' : '选择背景'}</span>
                </div>
              </div>
              {form.chatBackground && (
                <button
                  className="btn-ghost text-xs text-tavern-danger shrink-0"
                  onClick={() => update({ chatBackground: undefined })}
                >
                  移除背景
                </button>
              )}
            </div>
            <p className="text-xs text-tavern-text-muted mt-1">为该角色设置专属的聊天页背景图</p>
          </div>
        </div>

        {/* 对话后指令 */}
        <div className="field-card">
          <label className="label">对话后指令</label>
          <textarea
            ref={taPosthist.ref}
            style={taPosthist.style}
            className="textarea min-h-[60px] resize-y"
            value={form.postHistoryInstructions || ''}
            onChange={(e) => update({ postHistoryInstructions: e.target.value })}
            placeholder="如：始终使用中文回复、禁止使用emoji、每次回复不超过200字..."
          />
        </div>

        {/* 角色级作者注释 */}
        <div className="space-y-3 field-card">
          <div className="flex items-center justify-between">
            <div>
              <label className="label mb-0">角色级作者注释</label>
              <p className="text-xs text-tavern-text-muted">自定义后覆盖全局设置，关闭后使用全局</p>
            </div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                className="accent-[var(--color-accent)]"
                checked={!!form.authorNote}
                onChange={(e) => update({ authorNote: e.target.checked ? { enabled: true, text: '', position: 'middle', depth: 1 } : undefined })}
              />
              <span className="text-sm">自定义</span>
            </label>
          </div>
          {form.authorNote && (
            <>
              <div className="flex items-center justify-between">
                <label className="label mb-0">启用注入</label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    className="accent-[var(--color-accent)]"
                    checked={form.authorNote.enabled}
                    onChange={(e) => update({ authorNote: { ...form.authorNote!, enabled: e.target.checked } })}
                  />
                  <span className="text-sm">{form.authorNote.enabled ? '开' : '关'}</span>
                </label>
              </div>
              <div>
                <label className="label">注释内容</label>
                <textarea
                  className="textarea min-h-[60px] resize-y"
                  value={form.authorNote.text || ''}
                  onChange={(e) => update({ authorNote: { ...form.authorNote!, text: e.target.value } })}
                  placeholder="该角色独享的剧情引导，如：她暗恋主角但不愿承认…"
                />
              </div>
              <div>
                <label className="label">注入位置</label>
                <select
                  className="select"
                  value={form.authorNote.position}
                  onChange={(e) => update({ authorNote: { ...form.authorNote!, position: e.target.value as 'top' | 'middle' | 'bottom' } })}
                >
                  <option value="top">系统提示之后</option>
                  <option value="middle">历史消息中（按深度）</option>
                  <option value="bottom">历史消息末尾</option>
                </select>
              </div>
              {form.authorNote.position === 'middle' && (
                <div>
                  <label className="label">注入深度（0 = 最新消息前）</label>
                  <input
                    type="number"
                    min={0}
                    className="input"
                    value={form.authorNote.depth ?? 1}
                    onChange={(e) => update({ authorNote: { ...form.authorNote!, depth: Math.max(0, Number(e.target.value) || 0) } })}
                  />
                </div>
              )}
            </>
          )}
        </div>

        {/* 长记忆默认配置：新会话继承 */}
        <div className="space-y-3 field-card">
          <div className="flex items-center justify-between">
            <div>
              <label className="label mb-0">长记忆默认开启</label>
              <p className="text-xs text-tavern-text-muted">与该角色新建会话时自动启用长记忆（会话内可单独调整）</p>
            </div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                className="accent-[var(--color-accent)]"
                checked={!!form.defaultMemoryEnabled}
                onChange={(e) => update({ defaultMemoryEnabled: e.target.checked, defaultMemoryMode: e.target.checked ? (form.defaultMemoryMode ?? 'auto') : undefined })}
              />
              <span className="text-sm">{form.defaultMemoryEnabled ? '开' : '关'}</span>
            </label>
          </div>
          {form.defaultMemoryEnabled && (
            <>
              <div className="flex items-center justify-between">
                <label className="label mb-0">默认总结模式</label>
                <select
                  className="select w-28"
                  value={form.defaultMemoryMode ?? 'auto'}
                  onChange={(e) => update({ defaultMemoryMode: e.target.value as 'manual' | 'auto' })}
                >
                  <option value="manual">手动</option>
                  <option value="auto">自动</option>
                </select>
              </div>
              <div className="flex items-center justify-between">
                <label className="label mb-0">自动总结间隔（条）</label>
                <input
                  type="number"
                  min={4}
                  max={50}
                  className="input w-20"
                  value={form.defaultMemoryInterval ?? 10}
                  onChange={(e) => update({ defaultMemoryInterval: Math.max(4, Math.min(50, Number(e.target.value) || 10)) })}
                />
              </div>
            </>
          )}
        </div>

        {/* 群聊开场白 */}
        <div className="field-card">
          <label className="label">群聊开场白</label>
          <div className="space-y-2">
            {(form.groupOnlyGreetings || []).map((g, i) => (
              <div key={i} className="flex gap-2">
                <textarea
                  className="textarea min-h-[60px] resize-y flex-1 text-sm"
                  value={g}
                  onChange={(e) => {
                    const updated = [...(form.groupOnlyGreetings || [])]
                    updated[i] = e.target.value
                    update({ groupOnlyGreetings: updated })
                  }}
                  placeholder="群聊中使用的开场问候语"
                />
                <button
                  className="btn-ghost p-1.5 text-tavern-danger self-start shrink-0"
                  onClick={() => update({ groupOnlyGreetings: (form.groupOnlyGreetings || []).filter((_, j) => j !== i) })}
                  title="删除"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            ))}
            <button
              className="btn-ghost text-sm text-tavern-accent"
              onClick={() => update({ groupOnlyGreetings: [...(form.groupOnlyGreetings || []), ''] })}
            >
              + 添加群聊开场白
            </button>
          </div>
        </div>

        {/* 对话示例 */}
        <div className="field-card">
          <label className="label">
            对话示例
            {(translatedFields.has('exampleDialog') || form.translatedContent?.exampleDialog) && (
              <span className="text-xs text-tavern-accent ml-1">(已翻译)</span>
            )}
            <button
              className="ml-2 p-0.5 rounded text-tavern-text-muted hover:text-tavern-accent hover:bg-tavern-accent-soft transition-colors align-middle"
              onClick={() => handleTranslateField('exampleDialog')}
              disabled={translatingField === 'exampleDialog' || !form.exampleDialog}
              title="AI 翻译此字段"
            >
              {translatingField === 'exampleDialog' ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Languages className="w-3.5 h-3.5" />
              )}
            </button>
          </label>
          <textarea
            ref={taExdialog.ref}
            style={taExdialog.style}
            className="textarea min-h-[100px] resize-y font-mono text-xs"
            value={form.exampleDialog}
            onChange={(e) => update({ exampleDialog: e.target.value })}
            placeholder={'<START>\n{{user}}: 你好\n{{char}}: 你好呀！'}
          />
          {form.translatedContent?.exampleDialog && (
            <div className="mt-1.5 pl-2 border-l-2 border-tavern-accent">
              <div className="flex items-center gap-1">
                <span className="text-xs text-tavern-accent font-medium">翻译：</span>
                <button
                  className="p-0.5 rounded text-tavern-text-muted hover:text-tavern-danger transition-colors"
                  onClick={() => {
                    const tc = { ...form.translatedContent }
                    delete tc.exampleDialog
                    update({ translatedContent: tc } as Partial<Character>)
                  }}
                  title="清除翻译"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
              <p className="text-xs text-tavern-text-soft mt-0.5 whitespace-pre-wrap">
                {form.translatedContent.exampleDialog}
              </p>
            </div>
          )}
          <p className="text-xs text-tavern-text-muted mt-1">
            使用 {'{{user}}'} 和 {'{{char}}'} 作为用户和角色名的占位符
          </p>
        </div>
    </>
  )
}
