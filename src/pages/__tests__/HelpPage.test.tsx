import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { HelpPage } from '../HelpPage'

describe('HelpPage 新用户指引', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(window.api.app as any) = {
      getVersion: vi.fn().mockResolvedValue('0.11.21'),
    }
  })

  it('默认显示新手入门 5 步与入口位置标签', async () => {
    render(<HelpPage />)
    await act(async () => {}) // 冲刷 getVersion 异步
    expect(screen.getByText('新手入门')).toBeTruthy()
    expect(screen.getByText('配置 AI 连接')).toBeTruthy()
    expect(screen.getByText('导入或创建角色')).toBeTruthy()
    expect(screen.getByText('开始对话')).toBeTruthy()
    expect(screen.getByText('解锁进阶功能')).toBeTruthy()
    expect(screen.getByText('备份数据')).toBeTruthy()
    // 入口位置标签
    expect(screen.getByText('设置页 → AI 服务')).toBeTruthy()
    expect(screen.getByText('角色管理页 → 导入 / 新建')).toBeTruthy()
    expect(screen.getByText('设置页 → 数据管理')).toBeTruthy()
  })

  it('新手提示条与扩充后的快捷键、核心功能渲染', async () => {
    render(<HelpPage />)
    await act(async () => {})
    expect(screen.getByText(/第一次使用/)).toBeTruthy()
    // 快捷键扩充（Ctrl+N / Ctrl+E / Ctrl+/ / Ctrl+Shift+C）
    expect(screen.getByText('Ctrl + N')).toBeTruthy()
    expect(screen.getByText('Ctrl + E')).toBeTruthy()
    expect(screen.getByText('Ctrl + /')).toBeTruthy()
    expect(screen.getByText('Ctrl + Shift + C')).toBeTruthy()
    // 核心功能扩充
    expect(screen.getByText('世界书（Lorebook）')).toBeTruthy()
    expect(screen.getByText('正则替换')).toBeTruthy()
    expect(screen.getByText('快捷回复')).toBeTruthy()
    expect(screen.getByText('TTS 朗读')).toBeTruthy()
    expect(screen.getByText('命令面板')).toBeTruthy()
  })

  it('FAQ 切换显示新增的新手常见问题', async () => {
    render(<HelpPage />)
    await act(async () => {})
    fireEvent.click(screen.getByText('常见问题'))
    // 新增条目
    expect(screen.getByText('如何配置本地 Ollama 模型？')).toBeTruthy()
    expect(screen.getByText('API Key 是否安全？')).toBeTruthy()
    expect(screen.getByText('什么是预设（Preset）？')).toBeTruthy()
    expect(screen.getByText('对话出错时如何排查？')).toBeTruthy()
    expect(screen.getByText('什么是快捷回复？')).toBeTruthy()
  })
})
