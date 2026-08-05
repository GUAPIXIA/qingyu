import { useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Upload, Wand2, RefreshCw, Loader2, AlertCircle, X, ImageOff } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useCharacterCreatorStore } from '../../store/useCharacterCreatorStore'
import { useSettingsStore } from '../../store/useSettingsStore'

/** 风格预设：点击追加到提示词 */
const COVER_STYLE_PRESETS = [
  { label: '二次元', tags: 'anime style, cel shading, vibrant colors, detailed eyes' },
  { label: '写实', tags: 'photorealistic, detailed, cinematic lighting, 8k uhd' },
  { label: '油画', tags: 'oil painting, classical art style, rich textures, dramatic lighting' },
  { label: '水彩', tags: 'watercolor, soft colors, artistic, delicate brushwork' },
  { label: '赛博朋克', tags: 'cyberpunk, neon lights, futuristic, dark atmosphere, glowing' },
  { label: '古风', tags: 'chinese traditional art, hanfu, ink wash painting, elegant' },
]

const COVER_SIZES = ['576x768', '768x1024', '512x768', '832x1216']

export function CoverStep() {
  const navigate = useNavigate()
  const store = useCharacterCreatorStore()
  // 注意：不能用 selector 直接调用 getActiveImageGen()——它每次返回新对象，
  // 违反 useSyncExternalStore 快照稳定性要求会导致无限重渲染（Maximum update depth exceeded）
  const activeImageGenId = useSettingsStore((s) => s.settings.activeImageGenModelId)
  const imageGenModels = useSettingsStore((s) => s.settings.imageGenModels)
  const activeImageGen = useMemo(
    () => imageGenModels.find((m) => m.id === activeImageGenId) ?? null,
    [activeImageGenId, imageGenModels],
  )
  const fileRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)

  const handleUploadFile = async (file: File) => {
    // 本地 File → base64（前端直接读，无需 IPC）
    try {
      const base64 = await readFileAsBase64(file)
      store.setCover(base64, 'upload')
    } catch (e) {
      useCharacterCreatorStore.setState({ error: `图片读取失败：${e instanceof Error ? e.message : String(e)}` })
    }
  }

  const handleBuildPrompt = () => {
    const ok = store.buildPromptFromDraft()
    if (!ok) {
      useCharacterCreatorStore.setState({ error: '请先完成「概念设定」中的角色名与描述，再构建提示词' })
    }
  }

  const hasCover = !!store.coverBase64

  return (
    <div className="grid grid-cols-1 md:grid-cols-[240px_1fr] gap-5 items-start">
      {/* 3:4 封面预览 */}
      <div className="space-y-2">
        <div className="relative aspect-[3/4] w-full rounded-xl border border-tavern-border-soft bg-tavern-bg-soft overflow-hidden flex items-center justify-center">
          {hasCover ? (
            <img src={store.coverBase64!} alt="封面预览" className="w-full h-full object-cover" />
          ) : (
            <div className="text-center text-tavern-text-muted p-4">
              <ImageOff className="w-8 h-8 mx-auto mb-2 opacity-50" />
              <p className="text-xs">3:4 封面预览</p>
              <p className="text-[11px] mt-1">上传或 AI 生成后显示</p>
            </div>
          )}
        </div>
        {hasCover && (
          <>
            {store.coverIsThumb && (
              <div className="flex items-start gap-1.5 px-2.5 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-600 text-xs animate-fade-in">
                <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-px" />
                <span>
                  草稿封面为压缩缩略图，保存前请重新上传或生成高清封面
                </span>
              </div>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                className="btn-secondary text-xs flex-1"
                onClick={() => fileRef.current?.click()}
              >
                <Upload className="w-3.5 h-3.5" />
                更换
              </button>
              <button
                type="button"
                className="btn-secondary text-xs"
                onClick={() => store.setCover(null)}
                title="移除封面"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) handleUploadFile(f)
            e.target.value = ''
          }}
        />
      </div>

      {/* 右侧操作区 */}
      <div className="space-y-4">
        {store.error && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-tavern-danger/10 border border-tavern-danger/30 text-tavern-danger text-sm animate-fade-in">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span className="flex-1">{store.error}</span>
            <button
              type="button"
              onClick={() => useCharacterCreatorStore.setState({ error: null })}
              className="p-0.5 hover:opacity-70"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Tab */}
        <div className="flex gap-1 p-1 rounded-lg bg-tavern-bg-soft w-fit">
          <button
            type="button"
            onClick={() => store.setCoverMode('upload')}
            className={cn(
              'px-3 py-1.5 rounded-md text-sm transition-colors flex items-center gap-1.5',
              store.coverMode === 'upload' ? 'bg-tavern-bg-card shadow-sm text-tavern-accent' : 'text-tavern-text-muted',
            )}
          >
            <Upload className="w-4 h-4" />
            上传图片
          </button>
          <button
            type="button"
            onClick={() => store.setCoverMode('generate')}
            className={cn(
              'px-3 py-1.5 rounded-md text-sm transition-colors flex items-center gap-1.5',
              store.coverMode === 'generate' ? 'bg-tavern-bg-card shadow-sm text-tavern-accent' : 'text-tavern-text-muted',
            )}
          >
            <Wand2 className="w-4 h-4" />
            AI 生成
          </button>
        </div>

        {store.coverMode === 'upload' ? (
          <div
            onDragOver={(e) => {
              e.preventDefault()
              setDragOver(true)
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragOver(false)
              const f = e.dataTransfer.files?.[0]
              if (f) handleUploadFile(f)
            }}
            onClick={() => fileRef.current?.click()}
            className={cn(
              'flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-10 cursor-pointer transition-colors',
              dragOver
                ? 'border-tavern-accent bg-tavern-accent-soft'
                : 'border-tavern-border hover:border-tavern-accent/50 hover:bg-tavern-bg-soft',
            )}
          >
            <Upload className="w-8 h-8 text-tavern-text-muted" />
            <p className="text-sm text-tavern-text-muted">点击选择或拖拽图片到此处</p>
            <p className="text-xs text-tavern-text-muted">建议 3:4 竖图；头像将自动从封面裁剪</p>
          </div>
        ) : (
          <div className="space-y-3">
            {!activeImageGen ? (
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 space-y-3">
                <div className="flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                  <div className="text-sm">
                    <p className="font-medium">尚未配置生图模组</p>
                    <p className="text-tavern-text-muted text-xs mt-1">
                      要使用 AI 生成封面，请先在 API 页面配置 SD WebUI 或 DALL-E
                    </p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button type="button" className="btn-primary text-xs" onClick={() => navigate('/api')}>
                    前往配置
                  </button>
                  <button type="button" className="btn-secondary text-xs" onClick={() => store.setCoverMode('upload')}>
                    改用上传图片
                  </button>
                  <button
                    type="button"
                    className="btn-secondary text-xs"
                    onClick={() => store.setStep(2)}
                  >
                    暂时跳过
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="label mb-0">提示词</label>
                    <button
                      type="button"
                      onClick={handleBuildPrompt}
                      className="flex items-center gap-1 text-xs text-tavern-accent hover:opacity-80"
                    >
                      <RefreshCw className="w-3 h-3" />
                      重新构建提示词
                    </button>
                  </div>
                  <textarea
                    value={store.coverPrompt}
                    onChange={(e) => store.setCoverPrompt(e.target.value)}
                    placeholder="点击「重新构建提示词」根据角色设定自动生成，也可手动编写"
                    className="textarea min-h-[110px] resize-y text-xs font-mono"
                  />
                </div>

                <div>
                  <label className="label mb-1.5">风格预设（点击追加）</label>
                  <div className="flex flex-wrap gap-1.5">
                    {COVER_STYLE_PRESETS.map((preset) => {
                      const applied = store.coverPrompt.includes(preset.tags.split(',')[0])
                      return (
                        <button
                          key={preset.label}
                          type="button"
                          onClick={() => {
                            if (applied) {
                              store.setCoverPrompt(
                                store.coverPrompt.replace(new RegExp(`,\\s*${preset.tags.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), ''),
                              )
                            } else {
                              store.setCoverPrompt(`${store.coverPrompt}, ${preset.tags}`)
                            }
                          }}
                          className={cn(
                            'px-2.5 py-1 rounded-full text-xs border transition-colors',
                            applied
                              ? 'bg-tavern-accent-soft border-tavern-accent/40 text-tavern-accent'
                              : 'border-tavern-border text-tavern-text-soft hover:border-tavern-accent/50',
                          )}
                        >
                          {preset.label}
                        </button>
                      )
                    })}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="label mb-1.5">尺寸</label>
                    <select
                      value={store.coverSize}
                      onChange={(e) => store.setCoverSize(e.target.value)}
                      className="input"
                    >
                      {COVER_SIZES.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="label mb-1.5">负面提示词（SD WebUI 专用）</label>
                    <input
                      type="text"
                      value={store.negativePrompt}
                      onChange={(e) => store.setNegativePrompt(e.target.value)}
                      placeholder="lowres, bad anatomy…"
                      className="input text-xs"
                    />
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => store.generateCover()}
                  disabled={store.isGeneratingCover}
                  className="btn-primary w-full"
                >
                  {store.isGeneratingCover ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      生成中…
                    </>
                  ) : (
                    <>
                      <Wand2 className="w-4 h-4" />
                      生成封面
                    </>
                  )}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('文件读取失败'))
    reader.readAsDataURL(file)
  })
}
