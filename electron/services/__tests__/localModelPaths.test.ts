import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveEmbeddingModelsRoot } from '../localModels/paths'

describe('resolveEmbeddingModelsRoot', () => {
  it('开发环境使用项目目录', () => {
    const appPath = join(process.cwd(), 'dev-project')
    expect(resolveEmbeddingModelsRoot({
      isPackaged: false,
      appPath,
      executablePath: join(process.cwd(), 'electron.exe'),
    })).toBe(join(resolve(appPath), 'models', 'embedding'))
  })

  it('打包环境使用可执行文件所在的安装目录', () => {
    const executablePath = join(process.cwd(), 'installed', 'QingYu.exe')
    expect(resolveEmbeddingModelsRoot({
      isPackaged: true,
      appPath: join(process.cwd(), 'resources', 'app.asar'),
      executablePath,
    })).toBe(join(dirname(resolve(executablePath)), 'models', 'embedding'))
  })
})
