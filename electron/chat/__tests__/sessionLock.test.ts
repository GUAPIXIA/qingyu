import { describe, it, expect, beforeEach } from 'vitest'
import { SessionLock } from '../sessionLock'

describe('SessionLock', () => {
  let lock: SessionLock
  beforeEach(() => (lock = new SessionLock()))

  it('tryAcquire 同 session 互斥', () => {
    expect(lock.tryAcquire('s1', 't1')).toBe(true)
    expect(lock.tryAcquire('s1', 't2')).toBe(false)
    expect(lock.holderOf('s1')).toBe('t1')
    expect(lock.release('s1', 't2')).toBe(false)
    expect(lock.release('s1', 't1')).toBe(true)
    expect(lock.tryAcquire('s1', 't2')).toBe(true)
  })

  it('不同 session 不互斥', () => {
    expect(lock.tryAcquire('s1', 't1')).toBe(true)
    expect(lock.tryAcquire('s2', 't1')).toBe(true)
  })

  it('公平排队 FIFO', async () => {
    lock.tryAcquire('s1', 't1')
    const p2 = lock.acquire('s1', 't2', 200)
    const p3 = lock.acquire('s1', 't3', 200)
    // t1 释放后 t2 获得
    lock.release('s1', 't1')
    expect(await p2).toBe(true)
    expect(lock.holderOf('s1')).toBe('t2')
    lock.release('s1', 't2')
    expect(await p3).toBe(true)
    expect(lock.holderOf('s1')).toBe('t3')
  })

  it('超时未获锁返回 false', async () => {
    lock.tryAcquire('s1', 't1')
    const p = lock.acquire('s1', 't2', 20)
    expect(await p).toBe(false)
    expect(lock.holderOf('s1')).toBe('t1')
  })

  it('同一 task 重复 acquire 幂等', () => {
    expect(lock.tryAcquire('s1', 't1')).toBe(true)
    expect(lock.tryAcquire('s1', 't1')).toBe(true)
  })
})
