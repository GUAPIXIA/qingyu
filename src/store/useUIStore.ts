import { create } from 'zustand'

interface UIState {
  sidebarCollapsed: boolean
  contextPanelOpen: boolean
  toggleSidebar: () => void
  toggleContextPanel: () => void
  setSidebarCollapsed: (collapsed: boolean) => void
  setContextPanelOpen: (open: boolean) => void
}

export const useUIStore = create<UIState>((set) => ({
  sidebarCollapsed: false,
  contextPanelOpen: false,
  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  toggleContextPanel: () => set((state) => ({ contextPanelOpen: !state.contextPanelOpen })),
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  setContextPanelOpen: (open) => set({ contextPanelOpen: open }),
}))
