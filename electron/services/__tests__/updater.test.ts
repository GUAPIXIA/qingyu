/** 在线更新服务：固定服务器/GitHub 双源检查与 GitHub 自动下载。 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const electronState = vi.hoisted(() => ({ isPackaged: false, version: '1.0.0' }))
const updaterEvents = vi.hoisted(() => new Map<string, (...args: unknown[]) => void>())
const fetchMock = vi.hoisted(() => vi.fn())
const updaterMock = vi.hoisted(() => ({
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(),
  on: vi.fn((name: string, handler: (...args: unknown[]) => void) => {
    updaterEvents.set(name, handler)
  }),
  quitAndInstall: vi.fn(),
  setFeedURL: vi.fn(),
  currentVersion: { version: '1.0.0' },
  autoDownload: true,
  autoInstallOnAppQuit: false,
}))

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: {
    getVersion: () => electronState.version,
    get isPackaged() { return electronState.isPackaged },
  },
}))

vi.mock('electron-updater', () => ({ autoUpdater: updaterMock }))

const { checkForUpdates, installUpdate, isNewerVersion, parseServerLatestYaml } = await import('../updater')

function serverYaml(version: string): string {
  return `version: ${version}\npath: QingYu-Setup-${version}.exe\nsha512: test\n`
}

function mockServer(version = '1.0.0'): void {
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    text: vi.fn().mockResolvedValue(serverYaml(version)),
  })
}

beforeEach(() => {
  electronState.isPackaged = false
  electronState.version = '1.0.0'
  updaterMock.checkForUpdates.mockReset()
  updaterMock.downloadUpdate.mockReset()
  updaterMock.on.mockClear()
  updaterMock.quitAndInstall.mockClear()
  updaterMock.setFeedURL.mockClear()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  mockServer()
})

describe('version helpers', () => {
  it('按 SemVer 正确比较预发布版本', () => {
    expect(isNewerVersion('1.0.0-beta.2', '1.0.0-beta.10')).toBe(true)
    expect(isNewerVersion('1.0.0-rc.1', '1.0.0')).toBe(true)
    expect(isNewerVersion('1.0.0', '1.0.0-beta.2')).toBe(false)
  })

  it('从服务器 latest.yml 解析版本与同源安装包地址', () => {
    expect(parseServerLatestYaml(serverYaml('1.2.3'))).toEqual({
      version: '1.2.3',
      downloadUrl: 'https://cjbtj.xyz/qingyu/update/QingYu-Setup-1.2.3.exe',
    })
  })

  it('拒绝服务器清单中的跨域安装包地址', () => {
    expect(() => parseServerLatestYaml('version: 1.2.3\npath: https://evil.example/app.exe\n')).toThrow(/不安全/)
  })
})

describe('checkForUpdates', () => {
  it('开发模式明确提示不支持在线更新', async () => {
    const result = await checkForUpdates()
    expect(result).toMatchObject({ status: 'error', message: expect.stringContaining('当前环境不支持在线更新') })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(updaterMock.checkForUpdates).not.toHaveBeenCalled()
  })

  it('并行保留服务器与 GitHub 的版本结果', async () => {
    electronState.isPackaged = true
    mockServer('1.0.2')
    updaterMock.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: { version: '1.0.1', releaseNotes: 'GitHub notes' },
    })

    const result = await checkForUpdates()

    expect(result).toMatchObject({
      status: 'available',
      version: '1.0.1',
      hasAvailableUpdate: true,
      server: { status: 'available', version: '1.0.2' },
      github: { status: 'available', version: '1.0.1' },
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://cjbtj.xyz/qingyu/update/latest.yml',
      expect.objectContaining({ cache: 'no-store' }),
    )
    expect(updaterMock.setFeedURL).toHaveBeenCalledWith({ provider: 'github', owner: 'GUAPIXIA', repo: 'qingyu' })
  })

  it('只有服务器有新版时提供服务器结果但不伪造 GitHub 更新', async () => {
    electronState.isPackaged = true
    mockServer('1.0.1')
    updaterMock.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: false,
      updateInfo: { version: '1.0.0' },
    })

    const result = await checkForUpdates()

    expect(result).toMatchObject({
      status: 'available',
      version: '1.0.1',
      server: { status: 'available', version: '1.0.1' },
      github: { status: 'none', version: '1.0.0' },
    })
    expect(result.message).toContain('GitHub 暂未同步')
  })

  it('单个来源失败时仍返回另一来源的有效结果', async () => {
    electronState.isPackaged = true
    fetchMock.mockRejectedValue(new Error('server offline'))
    updaterMock.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: { version: '1.0.1' },
    })

    const result = await checkForUpdates()

    expect(result).toMatchObject({
      status: 'available',
      server: { status: 'error', message: 'server offline' },
      github: { status: 'available', version: '1.0.1' },
    })
  })

  it('两个来源都失败时返回 error，而不是误报最新', async () => {
    electronState.isPackaged = true
    fetchMock.mockRejectedValue(new Error('server offline'))
    updaterMock.checkForUpdates.mockRejectedValue(new Error('github offline'))

    const result = await checkForUpdates()

    expect(result).toMatchObject({ status: 'error', hasAvailableUpdate: false })
    expect(result.message).toContain('server offline')
    expect(result.message).toContain('github offline')
  })

  it('两个来源都没有新版时仍显示各自最新版本', async () => {
    electronState.isPackaged = true
    updaterMock.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: false,
      updateInfo: { version: '1.0.0' },
    })

    const result = await checkForUpdates()

    expect(result).toMatchObject({
      status: 'none',
      hasAvailableUpdate: false,
      server: { status: 'none', version: '1.0.0' },
      github: { status: 'none', version: '1.0.0' },
    })
  })
})

describe('installUpdate', () => {
  it('GitHub 下载完成后使用静默模式安装并重启', async () => {
    electronState.isPackaged = true
    updaterMock.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: { version: '1.0.1' },
    })
    await checkForUpdates()

    updaterEvents.get('update-downloaded')?.({ version: '1.0.1' })
    installUpdate()

    expect(updaterMock.quitAndInstall).toHaveBeenCalledWith(true, true)
  })
})
