import type { App, BrowserWindow, Dialog, IpcMain } from 'electron'
import { DIRS } from '../services/storage'
import { BUILTIN_MODEL_CATALOG, MODEL_CATALOG_PUBLIC_KEY } from '../services/localModels/catalog'
import { LocalModelManager } from '../services/localModels/manager'
import type { LocalModelUninstallRequest } from '../../shared/localModels'
import { listLorebookViews } from '../services/lorebookDocumentStore'
import { saveVectorIndex, type VectorSpace } from '../services/vectorStore'
import { readSettingsFromDisk } from './settings'
import { resolveEmbeddingModelsRoot } from '../services/localModels/paths'
import { embedLorebookEntries } from '../services/lorebookEmbeddingIndex'

let manager: LocalModelManager | null = null

interface LocalModelAppEnvironment {
  version: string
  isPackaged: boolean
  appPath: string
  executablePath: string
}

let appEnvironment: LocalModelAppEnvironment | null = null

function modelRoot(): string {
  if (!appEnvironment) throw new Error('本地模型服务尚未完成初始化')
  return resolveEmbeddingModelsRoot(appEnvironment)
}

export function getLocalModelManager(notify?: (task: unknown) => void): LocalModelManager {
  if (!manager) {
    manager = new LocalModelManager({
      modelsRoot: modelRoot(),
      indexesRoot: DIRS.embeddingIndexes(),
      appVersion: appEnvironment!.version,
      catalog: BUILTIN_MODEL_CATALOG,
      publicKeyPem: MODEL_CATALOG_PUBLIC_KEY,
      batchSize: () => readSettingsFromDisk().localModels?.batchSize,
      onProgress: notify,
    })
  }
  return manager
}

export function registerLocalModelIPC(
  ipcMain: IpcMain,
  dialog: Dialog,
  app: App,
  getWindows: () => BrowserWindow[],
): void {
  appEnvironment = {
    version: app.getVersion(),
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    executablePath: app.getPath('exe'),
  }
  const service = getLocalModelManager((task) => {
    for (const window of getWindows()) window.webContents.send('localModel:progress', { task })
  })
  ipcMain.handle('localModel:catalog', () => service.catalog())
  ipcMain.handle('localModel:installed', () => service.installed())
  ipcMain.handle('localModel:tasks', () => service.listTasks())
  ipcMain.handle('localModel:install', (_event, modelId: string, version: string) => service.install(modelId, version))
  ipcMain.handle('localModel:importPackage', async () => {
    const selected = await dialog.showOpenDialog({
      title: '导入离线向量模型包',
      filters: [{ name: '轻语模型包', extensions: ['qymodel'] }],
      properties: ['openFile'],
    })
    if (selected.canceled || selected.filePaths.length === 0) return null
    return service.importPackage(selected.filePaths[0])
  })
  ipcMain.handle('localModel:pause', (_event, taskId: string) => service.pause(taskId))
  ipcMain.handle('localModel:resume', (_event, taskId: string) => service.resume(taskId))
  ipcMain.handle('localModel:cancel', (_event, taskId: string) => service.cancel(taskId))
  ipcMain.handle('localModel:test', (_event, modelId: string, version: string) => service.test(modelId, version))
  ipcMain.handle('localModel:activate', (_event, modelId: string, version: string) => service.activate(modelId, version))
  ipcMain.handle('localModel:rollback', (_event, modelId: string) => service.rollback(modelId))
  ipcMain.handle('localModel:uninstallImpact', (_event, modelId: string, version: string) => service.uninstallImpact(modelId, version))
  ipcMain.handle('localModel:uninstall', (_event, request: LocalModelUninstallRequest) => service.uninstall(request))
  ipcMain.handle('localModel:storageUsage', () => service.storageUsage())
  ipcMain.handle('localModel:cleanup', () => service.cleanup())
  ipcMain.handle('localModel:rebuildIndexes', async () => {
    // 计划在每次启动/续跑时重新准备：暂停期间书目可能变化，续跑用最新列表。
    return service.runIndexJob(async () => {
      const books = await listLorebookViews(DIRS.lorebooks())
      return {
        totalBooks: books.length,
        indexBook: async (manifest, bookIndex) => {
          const book = books[bookIndex]
          if (!book) return
          const embedded = await embedLorebookEntries(
            book.entries,
            (texts, inputKind) => service.embed(texts, inputKind),
            Math.max(256, manifest.maxTokens * 2),
          )
          const model = `${manifest.id}@${manifest.version}`
          const space: VectorSpace = { provider: 'local', model, modelId: manifest.id, modelVersion: manifest.version }
          saveVectorIndex(book.id, model, embedded.vectors, space, book.runtime?.revision)
        },
      }
    })
  })
}
