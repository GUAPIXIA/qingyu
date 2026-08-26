import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { UpdaterSection } from '../UpdaterSection'

const QUARK_URL = 'https://pan.quark.cn/s/a9853284d260'

describe('UpdaterSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(window.api.updater.getState).mockResolvedValue({ status: 'idle', message: '' })
    vi.mocked(window.api.app.getVersion).mockResolvedValue('0.15.1')
  })

  it('未检查或没有新版时不显示手动下载区域和镜像设置', async () => {
    render(<UpdaterSection />)

    expect(await screen.findByText('当前版本 v0.15.1')).toBeInTheDocument()
    expect(screen.queryByText('手动下载安装包')).not.toBeInTheDocument()
    expect(screen.queryByText(/更新镜像源/)).not.toBeInTheDocument()
  })

  it('检查完成后分别显示服务器与 GitHub 版本', async () => {
    vi.mocked(window.api.updater.getState).mockResolvedValue({
      status: 'none',
      message: '未发现新版本',
      hasAvailableUpdate: false,
      server: { status: 'none', version: '0.15.1' },
      github: { status: 'none', version: '0.15.1' },
    })
    render(<UpdaterSection />)

    expect(await screen.findByText('服务器最新版本')).toBeInTheDocument()
    expect(screen.getByText('GitHub 最新版本')).toBeInTheDocument()
    expect(screen.getByText('当前版本 v0.15.1')).toBeInTheDocument()
    expect(screen.getAllByText('v0.15.1')).toHaveLength(2)
    expect(screen.queryByText('手动下载安装包')).not.toBeInTheDocument()
  })

  it('按实际可用来源展示对应版本的下载入口', async () => {
    vi.mocked(window.api.updater.getState).mockResolvedValue({
      status: 'available',
      message: '发现新版本',
      version: '0.15.2',
      hasAvailableUpdate: true,
      server: {
        status: 'available',
        version: '0.15.3',
        downloadUrl: 'https://cjbtj.xyz/qingyu/update/QingYu-Setup-0.15.3.exe',
      },
      github: { status: 'available', version: '0.15.2' },
    })
    render(<UpdaterSection />)

    fireEvent.click(await screen.findByRole('button', { name: /服务器下载/ }))
    expect(window.api.app.openExternal).toHaveBeenCalledWith(
      'https://cjbtj.xyz/qingyu/update/QingYu-Setup-0.15.3.exe',
    )

    fireEvent.click(screen.getByRole('button', { name: /GitHub 下载/ }))
    expect(window.api.app.openExternal).toHaveBeenCalledWith(
      'https://github.com/GUAPIXIA/qingyu/releases',
    )

    fireEvent.click(screen.getByRole('button', { name: QUARK_URL }))
    expect(window.api.app.openExternal).toHaveBeenCalledWith(QUARK_URL)
    expect(screen.getByText(/v0.15.3 · 国内线路/)).toBeInTheDocument()
    expect(screen.getByText(/v0.15.2 · Releases/)).toBeInTheDocument()
  })

  it('只有服务器有新版时不提供 GitHub 自动下载', async () => {
    vi.mocked(window.api.updater.getState).mockResolvedValue({
      status: 'available',
      message: '服务器已发布新版本，GitHub 暂未同步',
      version: '0.15.2',
      hasAvailableUpdate: true,
      server: {
        status: 'available',
        version: '0.15.2',
        downloadUrl: 'https://cjbtj.xyz/qingyu/update/QingYu-Setup-0.15.2.exe',
      },
      github: { status: 'none', version: '0.15.1' },
    })
    render(<UpdaterSection />)

    expect(await screen.findByRole('button', { name: /服务器下载/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /GitHub 下载/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '下载更新' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重新检查' })).toBeInTheDocument()
  })

  it('点击检查更新后渲染返回的双源结果', async () => {
    vi.mocked(window.api.updater.check).mockResolvedValue({
      status: 'none',
      message: '未发现新版本',
      hasAvailableUpdate: false,
      server: { status: 'none', version: '0.15.1' },
      github: { status: 'error', message: '网络不可达' },
    })
    render(<UpdaterSection />)

    fireEvent.click(await screen.findByRole('button', { name: '检查更新' }))
    await waitFor(() => expect(window.api.updater.check).toHaveBeenCalled())
    expect(await screen.findByText('获取失败')).toBeInTheDocument()
    expect(screen.getByText('服务器最新版本')).toBeInTheDocument()
  })
})
