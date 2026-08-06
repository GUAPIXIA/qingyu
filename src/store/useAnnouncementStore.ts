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
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), loading: false })
    }
  },

  selectAnnouncement: async (id: number) => {
    // N19 修复：详情始终从服务器获取（列表接口已不返回 content 全文），
    // 失败（离线等）时降级用列表缓存展示标题/摘要
    try {
      const detail = await window.api.announcement.fetchDetail(id)
      if (detail) {
        set({ selectedAnnouncement: detail })
        // 回写列表缓存，便于后续离线降级展示
        set((s) => ({ announcements: s.announcements.map((a) => (a.id === id ? detail : a)) }))
        return
      }
    } catch {
      // 网络错误，走降级
    }
    const cached = get().announcements.find((a) => a.id === id)
    if (cached) {
      set({ selectedAnnouncement: cached })
    }
  },

  clearSelection: () => {
    set({ selectedAnnouncement: null })
  },
}))
