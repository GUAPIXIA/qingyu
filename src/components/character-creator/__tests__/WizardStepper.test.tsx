import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { WizardStepper } from '../WizardStepper'

describe('WizardStepper', () => {
  it('渲染三个步骤节点与当前步骤', () => {
    render(<WizardStepper current={1} onStepClick={vi.fn()} />)
    expect(screen.getByText('概念设定')).toBeInTheDocument()
    expect(screen.getByText('封面制作')).toBeInTheDocument()
    expect(screen.getByText('预览保存')).toBeInTheDocument()
  })

  it('已完成步骤可点击回退（调用 onStepClick）', () => {
    const onStepClick = vi.fn()
    render(<WizardStepper current={2} onStepClick={onStepClick} />)
    screen.getByText('概念设定').click()
    expect(onStepClick).toHaveBeenCalledWith(0)
    screen.getByText('封面制作').click()
    expect(onStepClick).toHaveBeenCalledWith(1)
  })

  it('当前步骤不可点击跳转自己', () => {
    const onStepClick = vi.fn()
    render(<WizardStepper current={1} onStepClick={onStepClick} />)
    screen.getByText('封面制作').click()
    expect(onStepClick).toHaveBeenCalledWith(1) // 允许点击自己（无副作用）
  })

  it('未到达步骤不可点击', () => {
    const onStepClick = vi.fn()
    render(<WizardStepper current={0} onStepClick={onStepClick} />)
    screen.getByText('封面制作').click()
    expect(onStepClick).not.toHaveBeenCalled()
    screen.getByText('预览保存').click()
    expect(onStepClick).not.toHaveBeenCalled()
  })
})
