import { dirname, join, resolve } from 'node:path'

export interface LocalModelPathEnvironment {
  isPackaged: boolean
  appPath: string
  executablePath: string
}

/**
 * 开发时把模型留在项目目录，方便调试和清理；打包后把模型放在
 * 可执行文件同级目录，使模型跟随用户选择的应用安装位置。
 */
export function resolveEmbeddingModelsRoot(environment: LocalModelPathEnvironment): string {
  const base = environment.isPackaged
    ? dirname(resolve(environment.executablePath))
    : resolve(environment.appPath)
  return join(base, 'models', 'embedding')
}
