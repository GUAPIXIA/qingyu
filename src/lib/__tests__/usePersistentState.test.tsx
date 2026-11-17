import { beforeEach, describe, expect, it } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { fireEvent } from '@testing-library/react'
import { usePersistentState, usePersistentSet } from '../usePersistentState'

/**
 * 界面选项持久化：写入 localStorage、重新挂载后恢复、脏值回退。
 */

function Counter({ storageKey }: { storageKey: string }) {
  const [count, setCount] = usePersistentState<number>(storageKey, 0)
  return (
    <button type="button" onClick={() => setCount((prev) => prev + 1)}>
      count:{count}
    </button>
  )
}

function Tabs({ storageKey }: { storageKey: string }) {
  const [tab, setTab] = usePersistentState<'guide' | 'faq'>(storageKey, 'guide', {
    validate: (value): value is 'guide' | 'faq' => value === 'guide' || value === 'faq',
  })
  return (
    <>
      <span>tab:{tab}</span>
      <button type="button" onClick={() => setTab('faq')}>切到 FAQ</button>
    </>
  )
}

function ExpandedSet({ storageKey }: { storageKey: string }) {
  const [items, setItems] = usePersistentSet(storageKey)
  return (
    <>
      <span>expanded:{[...items].join(',')}</span>
      <button type="button" onClick={() => setItems((prev) => new Set([...prev, `id-${prev.size + 1}`]))}>
        展开
      </button>
    </>
  )
}

describe('usePersistentState 界面选项持久化', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('默认返回 initial，写入后落到 localStorage', async () => {
    render(<Counter storageKey="test:count" />)
    expect(screen.getByText('count:0')).toBeTruthy()

    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('count:1')).toBeTruthy()
    expect(localStorage.getItem('test:count')).toBe('1')
  })

  it('重新挂载（相当于重启）后恢复上次的值', async () => {
    const first = render(<Counter storageKey="test:count" />)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('count:2')).toBeTruthy()
    first.unmount()

    render(<Counter storageKey="test:count" />)
    expect(screen.getByText('count:2')).toBeTruthy()
  })

  it('已存值不通过 validate 时回退默认值（枚举脏值保护）', async () => {
    localStorage.setItem('test:tab', JSON.stringify('removed-tab'))
    render(<Tabs storageKey="test:tab" />)
    expect(screen.getByText('tab:guide')).toBeTruthy()

    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('tab:faq')).toBeTruthy()
    expect(localStorage.getItem('test:tab')).toBe('"faq"')
  })

  it('JSON 损坏时回退默认值且不抛错', async () => {
    localStorage.setItem('test:count', '{not json')
    render(<Counter storageKey="test:count" />)
    expect(screen.getByText('count:0')).toBeTruthy()
  })

  it('集合类型按数组序列化，重新挂载后恢复', async () => {
    const first = render(<ExpandedSet storageKey="test:expanded" />)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('expanded:id-1,id-2')).toBeTruthy()
    expect(localStorage.getItem('test:expanded')).toBe('["id-1","id-2"]')
    first.unmount()

    render(<ExpandedSet storageKey="test:expanded" />)
    expect(screen.getByText('expanded:id-1,id-2')).toBeTruthy()
  })

  it('集合里非字符串的脏数据会被过滤', async () => {
    localStorage.setItem('test:expanded', JSON.stringify(['a', 42, null, 'b']))
    render(<ExpandedSet storageKey="test:expanded" />)
    expect(screen.getByText('expanded:a,b')).toBeTruthy()
  })

  it('localStorage 抛错（隐私模式）时不影响交互', async () => {
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = () => { throw new Error('quota') }
    try {
      render(<Counter storageKey="test:count" />)
      fireEvent.click(screen.getByRole('button'))
      await act(async () => {})
      expect(screen.getByText('count:1')).toBeTruthy()
    } finally {
      Storage.prototype.setItem = original
    }
  })
})
