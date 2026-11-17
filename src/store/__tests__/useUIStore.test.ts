import { beforeEach, describe, expect, it, vi } from 'vitest'

const SIDEBAR_KEY = 'sidebar-collapsed'
const GROUP_LIST_KEY = 'group-chat-list-collapsed'

/**
 * 侧栏 / 群聊列表收起状态的持久化：
 * 用户收起后重启应用应保持收起，所以状态必须落到 localStorage（见 useUIStore）。
 * 每个用例 resetModules 后动态 import，保证拿到「按 localStorage 初始化」的新 store。
 */
describe('useUIStore 收起状态持久化', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.resetModules()
  })

  it('toggleSidebar 收起/展开都会写入 localStorage', async () => {
    const { useUIStore } = await import('../useUIStore')
    useUIStore.setState({ sidebarCollapsed: false })

    useUIStore.getState().toggleSidebar()
    expect(useUIStore.getState().sidebarCollapsed).toBe(true)
    expect(localStorage.getItem(SIDEBAR_KEY)).toBe('1')

    useUIStore.getState().toggleSidebar()
    expect(useUIStore.getState().sidebarCollapsed).toBe(false)
    expect(localStorage.getItem(SIDEBAR_KEY)).toBe('0')
  })

  it('setSidebarCollapsed 同样持久化', async () => {
    const { useUIStore } = await import('../useUIStore')
    useUIStore.getState().setSidebarCollapsed(true)
    expect(localStorage.getItem(SIDEBAR_KEY)).toBe('1')
  })

  it('重启（重新初始化 store）后保持收起状态', async () => {
    localStorage.setItem(SIDEBAR_KEY, '1')
    const { useUIStore } = await import('../useUIStore')
    expect(useUIStore.getState().sidebarCollapsed).toBe(true)
  })

  it('无持久化记录时默认展开', async () => {
    const { useUIStore } = await import('../useUIStore')
    expect(useUIStore.getState().sidebarCollapsed).toBe(false)
  })

  it('群聊列表的收起状态也独立持久化', async () => {
    const { useUIStore } = await import('../useUIStore')
    useUIStore.getState().toggleGroupListCollapsed()
    expect(localStorage.getItem(GROUP_LIST_KEY)).toBe('1')
    expect(localStorage.getItem(SIDEBAR_KEY)).toBeNull()
  })
})
