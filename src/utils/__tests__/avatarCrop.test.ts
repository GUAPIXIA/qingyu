import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cropAvatar, cropCoverTo34, downscaleImage } from '../avatarCrop'

/** 可控 Image mock：设置 src 时同步触发 onload/onerror */
class FakeImage {
  width = 0
  height = 0
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  private _src = ''
  constructor(private fail = false) {}

  set src(v: string) {
    this._src = v
    if (this.fail) {
      this.onerror?.()
    } else {
      this.onload?.()
    }
  }
  get src() {
    return this._src
  }
}

/** 捕获 drawImage 调用的 canvas 2d context mock */
const drawCalls: unknown[][] = []
const ctxMock = {
  drawImage: (...args: unknown[]) => {
    drawCalls.push(args)
  },
}

beforeEach(() => {
  drawCalls.length = 0
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubImage(width: number, height: number, fail = false) {
  vi.stubGlobal('Image', class extends FakeImage {
    constructor() {
      super(fail)
      this.width = width
      this.height = height
    }
  })
}

function stubCanvas() {
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ctxMock) as unknown as typeof HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.toDataURL = vi.fn(function (this: HTMLCanvasElement, type?: string) {
    return `data:${type ?? 'image/png'};base64,mock-${this.width}x${this.height}`
  }) as unknown as typeof HTMLCanvasElement.prototype.toDataURL}

describe('cropImage / cropAvatar', () => {
  it('中心裁剪：图宽 300 高 400 → 1:1 裁 300×300，垂直偏移 50', async () => {
    stubImage(300, 400)
    stubCanvas()
    const result = await cropAvatar('data:image/jpeg;base64,xxx')
    expect(result).toBe('data:image/jpeg;base64,mock-256x256')
    expect(drawCalls[0]?.slice(1, 7)).toEqual([0, 50, 300, 300, 0, 0])
  })

  it('top 锚点：offsetY = 0', async () => {
    stubImage(300, 400)
    stubCanvas()
    await cropAvatar('x', { position: 'top' })
    expect(drawCalls[0]?.[2]).toBe(0)
  })

  it('bottom 锚点：offsetY = 高 - 裁剪高', async () => {
    stubImage(300, 400)
    stubCanvas()
    await cropAvatar('x', { position: 'bottom' })
    expect(drawCalls[0]?.[2]).toBe(100)
  })

  it('图更宽时水平居中裁（400×300 → 1:1 裁 300×300，水平偏移 50）', async () => {
    stubImage(400, 300)
    stubCanvas()
    await cropAvatar('x')
    expect(drawCalls[0]?.slice(1, 7)).toEqual([50, 0, 300, 300, 0, 0])
  })

  it('自定义输出尺寸与 png 格式', async () => {
    stubImage(200, 200)
    stubCanvas()
    const result = await cropAvatar('x', { size: 128, format: 'png' })
    expect(result).toBe('data:image/png;base64,mock-128x128')
  })

  it('坏图（onerror）返回 null', async () => {
    stubImage(0, 0, true)
    stubCanvas()
    expect(await cropAvatar('bad')).toBeNull()
  })

  it('getContext 返回 null（如无 canvas 环境）返回 null 不抛异常', async () => {
    stubImage(100, 100)
    HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as unknown as typeof HTMLCanvasElement.prototype.getContext
    expect(await cropAvatar('x')).toBeNull()
  })
})

describe('cropCoverTo34', () => {
  it('正方形 800×800 → 3:4 裁 600×800 居中，输出 768×1024', async () => {
    stubImage(800, 800)
    stubCanvas()
    const result = await cropCoverTo34('x')
    expect(result).toBe('data:image/jpeg;base64,mock-768x1024')
    expect(drawCalls[0]?.slice(1, 7)).toEqual([100, 0, 600, 800, 0, 0])
  })
})

describe('downscaleImage', () => {
  it('等比降采样到 maxW×maxH 内（400×800 → 128×256）', async () => {
    stubImage(400, 800)
    stubCanvas()
    const result = await downscaleImage('x', 192, 256)
    expect(result).toBe('data:image/jpeg;base64,mock-128x256')
    expect(drawCalls[0]?.slice(1, 5)).toEqual([0, 0, 128, 256])
  })

  it('小于上限时原样返回', async () => {
    stubImage(100, 100)
    stubCanvas()
    const result = await downscaleImage('x', 192, 256)
    expect(result).toBe('x')
    expect(drawCalls).toHaveLength(0)
  })
})
