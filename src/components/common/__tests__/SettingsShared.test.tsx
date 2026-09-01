import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { SectionCard } from '../SettingsShared'

describe('SectionCard 设置分区', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('重新挂载后保留用户的折叠状态', () => {
    const first = render(
      <SectionCard title="测试分区" icon={<span />} storageKey="test-section">
        分区内容
      </SectionCard>
    )

    fireEvent.click(screen.getByRole('button', { name: '测试分区' }))
    expect(screen.queryByText('分区内容')).toBeNull()
    first.unmount()

    render(
      <SectionCard title="测试分区" icon={<span />} storageKey="test-section">
        分区内容
      </SectionCard>
    )

    expect(screen.queryByText('分区内容')).toBeNull()
    expect(screen.getByRole('button', { name: '测试分区' }).getAttribute('aria-expanded')).toBe('false')
  })

  it('不同分区使用各自独立的折叠状态', () => {
    const first = render(
      <SectionCard title="第一个分区" icon={<span />} storageKey="first-section">
        第一个内容
      </SectionCard>
    )
    fireEvent.click(screen.getByRole('button', { name: '第一个分区' }))
    first.unmount()

    render(
      <SectionCard title="第二个分区" icon={<span />} storageKey="second-section">
        第二个内容
      </SectionCard>
    )

    expect(screen.getByText('第二个内容')).toBeTruthy()
  })
})
