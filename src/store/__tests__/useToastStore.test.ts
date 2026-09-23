import { describe, expect, it, beforeEach } from 'vitest'
import { useToastStore } from '../useToastStore'

describe('useToastStore', () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] })
  })

  it('push 添加 toast 并返回 id', () => {
    const id = useToastStore.getState().push({ title: 'hello', variant: 'info' })
    expect(id).toBeTruthy()
    expect(useToastStore.getState().toasts).toHaveLength(1)
    expect(useToastStore.getState().toasts[0].title).toBe('hello')
    expect(useToastStore.getState().toasts[0].durationMs).toBe(4000)
  })

  it('error 默认时长更长', () => {
    useToastStore.getState().push({ title: 'err', variant: 'error' })
    expect(useToastStore.getState().toasts[0].durationMs).toBe(8000)
  })

  it('同 requestId 只保留最新', () => {
    useToastStore.getState().push({ title: 'old', requestId: 'r1' })
    useToastStore.getState().push({ title: 'new', requestId: 'r1' })
    const toasts = useToastStore.getState().toasts
    expect(toasts).toHaveLength(1)
    expect(toasts[0].title).toBe('new')
  })

  it('dismiss 移除单条', () => {
    const id = useToastStore.getState().push({ title: 'a' })
    useToastStore.getState().push({ title: 'b' })
    useToastStore.getState().dismiss(id)
    expect(useToastStore.getState().toasts.map((t) => t.title)).toEqual(['b'])
  })

  it('超过上限只保留最新 5 条', () => {
    for (let i = 0; i < 7; i++) useToastStore.getState().push({ title: `t${i}` })
    expect(useToastStore.getState().toasts).toHaveLength(5)
    expect(useToastStore.getState().toasts[0].title).toBe('t2')
  })
})
