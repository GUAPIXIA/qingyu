import { X, Upload, Sun, Waves, Trees, Moon, Cloud, Flame } from 'lucide-react'
import { useCharacterStore } from '../../store/useCharacterStore'
import { cn } from '../../lib/utils'

interface BackgroundPanelProps {
  open: boolean
  onClose: () => void
}

export const PRESET_GRADIENTS = [
  { key: 'sunset', label: '日落', icon: Sun, css: 'linear-gradient(135deg, #ff9a9e 0%, #fad0c4 50%, #fbc2eb 100%)' },
  { key: 'ocean', label: '海洋', icon: Waves, css: 'linear-gradient(135deg, #a18cd1 0%, #fbc2eb 50%, #8fd3f4 100%)' },
  { key: 'forest', label: '森林', icon: Trees, css: 'linear-gradient(135deg, #84fab0 0%, #8fd3f4 50%, #a8edea 100%)' },
  { key: 'midnight', label: '午夜', icon: Moon, css: 'linear-gradient(135deg, #2b2d42 0%, #8d99ae 50%, #edf2f4 100%)' },
  { key: 'cherry', label: '樱花', icon: Cloud, css: 'linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 50%, #e8c3c8 100%)' },
  { key: 'ember', label: '余烬', icon: Flame, css: 'linear-gradient(135deg, #f7971e 0%, #ffd200 50%, #ffe259 100%)' },
] as const

export function BackgroundPanel({ open, onClose }: BackgroundPanelProps) {
  const { currentCharacter, saveCharacter } = useCharacterStore()
  const character = currentCharacter

  if (!open || !character) return null

  const params = character.chatBackgroundParams ?? { opacity: 12, blur: 2, type: 'image' as const, posX: 50, posY: 50, scale: 100 }
  const opacity = params.opacity ?? 12
  const blur = params.blur ?? 2
  const bgType = params.type ?? 'image'
  const activeGradient = params.gradient
  const posX = params.posX ?? 50
  const posY = params.posY ?? 50
  const scale = params.scale ?? 100

  const updateBg = async (partial: Partial<NonNullable<typeof character.chatBackgroundParams>> & { chatBackground?: string | undefined }) => {
    const updated: typeof character = {
      ...character,
      chatBackground: partial.chatBackground !== undefined ? partial.chatBackground : character.chatBackground,
      chatBackgroundParams: {
        opacity: partial.opacity ?? opacity,
        blur: partial.blur ?? blur,
        type: partial.type ?? bgType,
        gradient: partial.gradient !== undefined ? partial.gradient : activeGradient,
        posX: partial.posX ?? posX,
        posY: partial.posY ?? posY,
        scale: partial.scale ?? scale,
      },
    }
    await saveCharacter(updated)
  }

  const handleSelectGradient = (key: string) => {
    updateBg({ type: 'gradient', gradient: key })
  }

  const handleSelectImage = async () => {
    const path = await window.api.file.selectImage()
    if (path) {
      const base64 = await window.api.file.readImageAsBase64(path)
      updateBg({ chatBackground: base64, type: 'image', gradient: undefined })
    }
  }

  const handleRemove = () => {
    updateBg({ chatBackground: undefined, gradient: undefined, type: 'image' })
  }

  const handleOpacityChange = (val: number) => {
    updateBg({ opacity: val })
  }

  const handleBlurChange = (val: number) => {
    updateBg({ blur: val })
  }

  return (
    <>
      {/* 遮罩 */}
      <div className="fixed inset-0 z-30" onClick={onClose} />
      {/* 面板 */}
      <div className="fixed right-0 top-0 bottom-0 w-80 z-40 bg-tavern-bg-card border-l border-tavern-border shadow-2xl overflow-y-auto">
        <div className="sticky top-0 z-10 flex items-center justify-between px-4 py-3 bg-tavern-bg-card/90 backdrop-blur border-b border-tavern-border-soft">
          <h3 className="text-sm font-semibold text-tavern-text">聊天背景</h3>
          <button className="btn-ghost p-1.5" onClick={onClose} title="关闭">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-5">
          {/* 预设渐变 */}
          <div>
            <label className="label">预设渐变</label>
            <div className="grid grid-cols-3 gap-2">
              {PRESET_GRADIENTS.map((g) => (
                <button
                  key={g.key}
                  onClick={() => handleSelectGradient(g.key)}
                  className={cn(
                    'flex flex-col items-center gap-1 p-2 rounded-lg border-2 transition-all',
                    activeGradient === g.key
                      ? 'border-tavern-accent shadow-md scale-105'
                      : 'border-tavern-border-soft hover:border-tavern-border hover:shadow-sm'
                  )}
                >
                  <div className="w-full aspect-video rounded-md" style={{ background: g.css }} />
                  <span className="text-[10px] text-tavern-text-soft leading-none">{g.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* 自定义图片 */}
          <div>
            <label className="label">自定义图片</label>
            <button
              onClick={handleSelectImage}
              className={cn(
                'w-full flex items-center justify-center gap-2 px-3 py-3 rounded-lg border-2 border-dashed transition-colors text-sm',
                'border-tavern-border-soft text-tavern-text-muted hover:border-tavern-accent hover:text-tavern-accent hover:bg-tavern-accent-soft/30'
              )}
            >
              <Upload className="w-4 h-4" />
              {character.chatBackground && bgType === 'image' ? '更换图片' : '选择本地图片'}
            </button>
            {character.chatBackground && bgType === 'image' && (
              <div className="mt-2 w-full h-16 rounded-lg overflow-hidden border border-tavern-border-soft">
                <img src={character.chatBackground} className="w-full h-full object-cover" alt="" />
              </div>
            )}
          </div>

          {/* 不透明度 */}
          <div>
            <label className="label">
              不透明度 <span className="text-xs text-tavern-text-muted ml-1">{opacity}%</span>
            </label>
            <input
              type="range"
              min="1"
              max="100"
              step="1"
              value={opacity}
              onChange={(e) => handleOpacityChange(Number(e.target.value))}
              className="w-full accent-tavern-accent"
            />
            <div className="flex justify-between text-[10px] text-tavern-text-muted">
              <span>淡</span>
              <span>浓</span>
            </div>
          </div>

          {/* 模糊 */}
          <div>
            <label className="label">
              模糊程度 <span className="text-xs text-tavern-text-muted ml-1">{blur}px</span>
            </label>
            <input
              type="range"
              min="0"
              max="8"
              step="1"
              value={blur}
              onChange={(e) => handleBlurChange(Number(e.target.value))}
              className="w-full accent-tavern-accent"
            />
            <div className="flex justify-between text-[10px] text-tavern-text-muted">
              <span>清晰</span>
              <span>模糊</span>
            </div>
          </div>

          {/* 图片位置 */}
          {character.chatBackground && bgType === 'image' && (
            <div>
              <label className="label">图片位置</label>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <span className="text-[10px] text-tavern-text-muted">水平: {posX}%</span>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    step="1"
                    value={posX}
                    onChange={(e) => updateBg({ posX: Number(e.target.value) })}
                    className="w-full accent-tavern-accent"
                  />
                </div>
                <div>
                  <span className="text-[10px] text-tavern-text-muted">垂直: {posY}%</span>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    step="1"
                    value={posY}
                    onChange={(e) => updateBg({ posY: Number(e.target.value) })}
                    className="w-full accent-tavern-accent"
                  />
                </div>
              </div>
            </div>
          )}

          {/* 图片缩放 (仅图片模式) */}
          {character.chatBackground && bgType === 'image' && (
            <div>
              <label className="label">
                缩放 <span className="text-xs text-tavern-text-muted ml-1">{scale}%</span>
              </label>
              <input
                type="range"
                min="50"
                max="200"
                step="5"
                value={scale}
                onChange={(e) => updateBg({ scale: Number(e.target.value) })}
                className="w-full accent-tavern-accent"
              />
              <div className="flex justify-between text-[10px] text-tavern-text-muted">
                <span>缩小</span>
                <span>放大</span>
              </div>
            </div>
          )}

          {/* 移除背景 */}
          {character.chatBackground && (
            <div className="pt-2 border-t border-tavern-border-soft">
              <button
                onClick={handleRemove}
                className="w-full btn-ghost text-sm text-tavern-danger py-2"
              >
                移除背景
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
