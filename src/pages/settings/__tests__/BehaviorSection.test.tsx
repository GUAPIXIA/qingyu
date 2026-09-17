import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/defaults'
import { BehaviorSection } from '../BehaviorSection'

describe('BehaviorSection', () => {
  beforeEach(() => localStorage.clear())

  it('按使用场景分组展示并保持原设置交互', () => {
    const updateSettings = vi.fn()
    render(<BehaviorSection settings={getDefaultSettings()} updateSettings={updateSettings} />)

    expect(screen.getByText('对话体验')).toBeTruthy()
    expect(screen.getByText('角色表达')).toBeTruthy()
    expect(screen.getByText('封面效果')).toBeTruthy()
    expect(screen.queryByText('检测到旧版生成设置')).toBeNull()

    fireEvent.click(screen.getByRole('switch', { name: '流式输出' }))
    expect(updateSettings).toHaveBeenCalledWith({ streamOutput: false })

    fireEvent.change(screen.getByRole('combobox', { name: '翻译目标语言' }), { target: { value: 'English' } })
    expect(updateSettings).toHaveBeenCalledWith({ translationTargetLang: 'English' })

    fireEvent.click(screen.getByRole('button', { name: '封面毛玻璃 16px' }))
    expect(updateSettings).toHaveBeenCalledWith({ coverBlurStrength: 16 })
  })
})
