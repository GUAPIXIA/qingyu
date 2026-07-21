import { app } from 'electron'
import { join } from 'node:path'
import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, unlinkSync, rmSync, renameSync } from 'node:fs'
import type { Settings } from '../../shared/types'

const APP_NAME = '轻语'

/** 获取数据目录 */
export function getDataDir(): string {
  return join(app.getPath('userData'), 'data')
}

/** 子目录定义 */
export const DIRS = {
  config: () => join(getDataDir(), 'config'),
  characters: () => join(getDataDir(), 'characters'),
  chats: () => join(getDataDir(), 'chats'),
  lorebooks: () => join(getDataDir(), 'lorebooks'),
  presets: () => join(getDataDir(), 'presets'),
  groups: () => join(getDataDir(), 'groups'),
  backups: () => join(getDataDir(), 'backups'),
} as const

/** 确保数据目录存在 */
export async function ensureDataDir(): Promise<void> {
  for (const dir of Object.values(DIRS)) {
    mkdirSync(dir(), { recursive: true })
  }
  // 如果没有 settings.json，创建默认配置
  const settingsPath = join(DIRS.config(), 'settings.json')
  if (!existsSync(settingsPath)) {
    writeFileSync(settingsPath, JSON.stringify(getDefaultSettings(), null, 2), 'utf-8')
  }
}

/** 默认设置 */
export function getDefaultSettings(): Settings {
  return {
    activeProvider: 'openai',
    providers: {
      openai: { type: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
      claude: { type: 'claude', baseUrl: 'https://api.anthropic.com', model: 'claude-3-5-sonnet-20241022' },
      gemini: { type: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-1.5-flash' },
      ollama: { type: 'ollama', baseUrl: 'http://localhost:11434', model: 'llama3.2' },
    },
    connectionProfiles: [],
    activeProfileId: null,
    activeModel: 'gpt-4o-mini',
    activePresetId: null,
    activeCharacterId: null,
    theme: 'dark',
    themeColor: 'amber',
    fontSize: 'comfortable',
    fontSizeCustom: 0,
    bubbleStyle: 'round',
    messageSpacing: 20,
    streamOutput: true,
    autoScroll: true,
    ttsEnabled: false,
    ttsModels: [],
    activeTTSModelId: null,
    imageGenModels: [],
    activeImageGenModelId: null,
    visionModels: [],
    activeVisionModelId: null,
    userName: '用户',
    userDescription: '',
    userPersona: '',
    activePersonaId: null,
    htmlRendering: false,
    showTokenCount: true,
  }
}

/** 读取 JSON 文件 */
export function readJson<T>(filePath: string): T | null {
  try {
    if (!existsSync(filePath)) return null
    const raw = readFileSync(filePath, 'utf-8')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

/** 写入 JSON 文件 */
// L-05 修复：使用 temp 文件 + rename 保证原子写入，防止崩溃时数据损坏
export function writeJson(filePath: string, data: unknown): void {
  mkdirSync(join(filePath, '..'), { recursive: true })
  const tmpPath = filePath + '.tmp'
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8')
  renameSync(tmpPath, filePath)
}

/** 列出目录下所有 JSON 文件 */
export function listJsonFiles<T>(dir: string): T[] {
  const results: T[] = []
  try {
    if (!existsSync(dir)) return results
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
    for (const file of files) {
      const data = readJson<T>(join(dir, file))
      if (data) results.push(data)
    }
  } catch {
    // 忽略错误
  }
  return results
}

/** 删除文件 */
export function removeFile(filePath: string): void {
  try {
    if (existsSync(filePath)) unlinkSync(filePath)
  } catch {
    // 忽略错误
  }
}

/** 删除目录 */
export function removeDir(dirPath: string): void {
  try {
    if (existsSync(dirPath)) rmSync(dirPath, { recursive: true, force: true })
  } catch {
    // 忽略错误
  }
}
