/**
 * electron 桩模块（ESM named exports）。
 */
export const app = {
  getPath: () => process.cwd(),
  getName: () => 'qingyu-lan-e2e',
  getVersion: () => '0.0.0-lan-e2e',
  isPackaged: false,
  on: () => {},
  whenReady: () => Promise.resolve(),
}
export const dialog = {
  showMessageBox: async () => ({ response: 0 }),
  showSaveDialog: async () => ({ canceled: true }),
}
export const ipcMain = { handle: () => {}, on: () => {} }
export class BrowserWindow {}
export const nativeImage = { createFromPath: () => ({}) }
export const shell = { openExternal: async () => {} }
export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: (s) => Buffer.from(String(s), 'utf8'),
  decryptString: (b) => Buffer.from(b).toString('utf8'),
}
export const clipboard = { writeText: () => {}, readText: () => '' }
export const screen = { getPrimaryDisplay: () => ({ size: { width: 1920, height: 1080 } }) }
export const session = { defaultSession: { clearCache: async () => {} } }
export const net = { fetch: globalThis.fetch }
export default {
  app,
  dialog,
  ipcMain,
  BrowserWindow,
  nativeImage,
  shell,
  safeStorage,
  clipboard,
  screen,
  session,
  net,
}

