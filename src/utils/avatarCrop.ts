/**
 * 头像/封面裁剪工具
 *
 * - cropAvatar: 从封面裁剪 1:1 头像（锚点 top/center/bottom，防全身图裁掉脸）
 * - cropCoverTo34: DALL-E 1024×1024 正方形 → 3:4 封面（768×1024）
 * - downscaleImage: 等比降采样（草稿持久化缩略图用）
 *
 * 所有函数在失败时返回 null，调用方留空即可，不阻塞保存流程。
 */

export interface CropOptions {
  /** 垂直锚点：top 保留头部区域，center 居中，bottom 保留下半身 */
  position?: 'top' | 'center' | 'bottom'
  /** 输出格式，默认 jpeg（体积约为 PNG 的 1/10） */
  format?: 'png' | 'jpeg'
  /** jpeg 质量，默认 0.9 */
  quality?: number
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片加载失败'))
    img.src = src
  })
}

/**
 * 按目标宽高比从图中裁剪（水平居中，垂直按锚点），输出指定短边尺寸。
 * @param targetRatio 宽/高比，如 1 表示 1:1，3/4 表示 3:4
 * @param shortSide   输出短边像素
 */
export async function cropImage(
  src: string,
  targetRatio: number,
  shortSide: number,
  options: CropOptions = {},
): Promise<string | null> {
  const { position = 'center', format = 'jpeg', quality = 0.9 } = options
  try {
    const img = await loadImage(src)
    if (!img.width || !img.height) return null

    // 源图裁剪区域（保持目标比例，水平居中）
    const imgRatio = img.width / img.height
    let cropW: number
    let cropH: number
    if (imgRatio > targetRatio) {
      // 图更宽：按高度定高，宽度居中裁
      cropH = img.height
      cropW = Math.round(cropH * targetRatio)
    } else {
      // 图更高：按宽度定宽，高度按锚点裁
      cropW = img.width
      cropH = Math.round(cropW / targetRatio)
    }
    const offsetX = (img.width - cropW) / 2
    let offsetY: number
    if (position === 'top') offsetY = 0
    else if (position === 'bottom') offsetY = img.height - cropH
    else offsetY = (img.height - cropH) / 2

    // 输出尺寸（短边固定）
    let outW: number
    let outH: number
    if (targetRatio >= 1) {
      outH = shortSide
      outW = Math.round(outH * targetRatio)
    } else {
      outW = shortSide
      outH = Math.round(outW / targetRatio)
    }

    const canvas = document.createElement('canvas')
    canvas.width = outW
    canvas.height = outH
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(img, offsetX, offsetY, cropW, cropH, 0, 0, outW, outH)
    return canvas.toDataURL(format === 'jpeg' ? 'image/jpeg' : 'image/png', quality)
  } catch {
    return null
  }
}

/** 裁剪 1:1 头像（默认 256×256 JPEG，约 30~60KB） */
export function cropAvatar(src: string, options: CropOptions & { size?: number } = {}): Promise<string | null> {
  return cropImage(src, 1, options.size ?? 256, options)
}

/** 裁剪 3:4 封面（DALL-E 1024² → 768×1024） */
export function cropCoverTo34(src: string, options: CropOptions = {}): Promise<string | null> {
  return cropImage(src, 3 / 4, 768, options)
}

/** 等比降采样到不超过 maxW×maxH（草稿持久化缩略图，jpeg q0.8） */
export async function downscaleImage(
  src: string,
  maxW: number,
  maxH: number,
  quality = 0.8,
): Promise<string | null> {
  try {
    const img = await loadImage(src)
    if (!img.width || !img.height) return null
    const scale = Math.min(1, maxW / img.width, maxH / img.height)
    if (scale >= 1) return src
    const w = Math.max(1, Math.round(img.width * scale))
    const h = Math.max(1, Math.round(img.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(img, 0, 0, w, h)
    return canvas.toDataURL('image/jpeg', quality)
  } catch {
    return null
  }
}
