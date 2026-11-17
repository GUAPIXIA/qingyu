import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { ChevronDown, ChevronRight } from 'lucide'
import { MorphingIcon } from '../MorphingIcon'

const dOf = (container: HTMLElement) => container.querySelector('svg > path')?.getAttribute('d') ?? ''

describe('MorphingIcon 状态对图标', () => {
  it('渲染为单个 path 的 svg，尺寸/描边与 lucide-react 一致', () => {
    const { container } = render(<MorphingIcon icon={ChevronDown} className="w-4 h-4" />)
    const svg = container.querySelector('svg')
    expect(svg).toBeTruthy()
    expect(svg?.getAttribute('width')).toBe('24')
    expect(svg?.getAttribute('height')).toBe('24')
    expect(svg?.getAttribute('stroke')).toBe('currentColor')
    expect(svg?.getAttribute('class')).toBe('w-4 h-4')
    expect(svg?.querySelectorAll('path')).toHaveLength(1)
    expect(dOf(container)).not.toBe('')
  })

  it('icon 变化时切到目标形状（reducedMotion="always" 瞬时切换）', () => {
    const { container, rerender } = render(
      <MorphingIcon icon={ChevronDown} reducedMotion="always" className="w-4 h-4" />,
    )
    const collapsed = dOf(container)
    rerender(<MorphingIcon icon={ChevronRight} reducedMotion="always" className="w-4 h-4" />)
    const expanded = dOf(container)
    expect(expanded).not.toBe(collapsed)
    // 首帧即目标形状：不依赖 rAF/弹簧推进，测试与 SSR 都可断言
    expect(expanded).toContain('M9 18')
  })

  it('未显式指定 reducedMotion 时默认跟随系统设置', () => {
    // setup.ts 的 matchMedia mock 返回 matches: false（系统未开启减弱动效）
    const { container } = render(<MorphingIcon icon={ChevronDown} className="w-4 h-4" />)
    expect(container.querySelector('svg > path')).toBeTruthy()
  })
})
