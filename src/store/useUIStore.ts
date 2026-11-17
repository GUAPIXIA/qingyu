import { create } from 'zustand'

/** 群聊列表收起状态持久化键：记住用户上次的选择，切页/重启后保持。 */
const GROUP_LIST_COLLAPSED_KEY = 'group-chat-list-collapsed'
/** 主侧栏收起状态持久化键：重启后保持用户上次的选择。 */
const SIDEBAR_COLLAPSED_KEY = 'sidebar-collapsed'

function readGroupListCollapsed(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(GROUP_LIST_COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

function persistGroupListCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(GROUP_LIST_COLLAPSED_KEY, collapsed ? '1' : '0')
  } catch {
    /* 隐私模式等场景忽略 */
  }
}

function readSidebarCollapsed(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

function persistSidebarCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0')
  } catch {
    /* 隐私模式等场景忽略 */
  }
}

interface UIState {
  sidebarCollapsed: boolean
  /** 群聊页左侧「群聊列表」是否收起（持久化，见 GROUP_LIST_COLLAPSED_KEY） */
  groupListCollapsed: boolean
  toggleSidebar: () => void
  toggleGroupListCollapsed: () => void
  setSidebarCollapsed: (collapsed: boolean) => void
  setGroupListCollapsed: (collapsed: boolean) => void
}

export const useUIStore = create<UIState>((set) => ({
  sidebarCollapsed: readSidebarCollapsed(),
  groupListCollapsed: readGroupListCollapsed(),
  toggleSidebar: () => set((state) => {
    const next = !state.sidebarCollapsed
    persistSidebarCollapsed(next)
    return { sidebarCollapsed: next }
  }),
  toggleGroupListCollapsed: () => set((state) => {
    const next = !state.groupListCollapsed
    persistGroupListCollapsed(next)
    return { groupListCollapsed: next }
  }),
  setSidebarCollapsed: (collapsed) => {
    persistSidebarCollapsed(collapsed)
    set({ sidebarCollapsed: collapsed })
  },
  setGroupListCollapsed: (collapsed) => {
    persistGroupListCollapsed(collapsed)
    set({ groupListCollapsed: collapsed })
  },
}))

