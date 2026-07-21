import { create } from 'zustand'
import type { Announcement } from '../../shared/types'

interface AnnouncementState {
  announcements: Announcement[]
  selectedAnnouncement: Announcement | null
  loading: boolean
  error: string | null

  loadAnnouncements: () => Promise<void>
  selectAnnouncement: (id: number) => Promise<void>
  clearSelection: () => void
}

export const useAnnouncementStore = create<AnnouncementState>((set, get) => ({
  announcements: [],
  selectedAnnouncement: null,
  loading: false,
  error: null,

  loadAnnouncements: async () => {
    set({ loading: true, error: null })
    try {
      const { items } = await window.api.announcement.fetchList(1, 100)
      set({ announcements: items, loading: false })
      // 如果当前选中的公告不在新列表中，清空选择
      const { selectedAnnouncement } = get()
      if (selectedAnnouncement && !items.find((a) => a.id === selectedAnnouncement.id)) {
        set({ selectedAnnouncement: null })
      }
    } catch (err: any) {
      set({ error: err.message || '加载公告失败', loading: false })
    }
  },

  selectAnnouncement: async (id: number) => {
    // 先尝试从已加载的列表中找到
    const cached = get().announcements.find((a) => a.id === id)
    if (cached) {
      set({ selectedAnnouncement: cached })
      return
    }
    // 从服务器获取详情
    try {
      const detail = await window.api.announcement.fetchDetail(id)
      if (detail) {
        set({ selectedAnnouncement: detail })
      }
    } catch {
      // 网络错误时静默处理
    }
  },

  clearSelection: () => {
    set({ selectedAnnouncement: null })
  },
}))
