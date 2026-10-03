import { join } from 'node:path'
import type { Settings } from '../../shared/types'
import { getDefaultSettings } from '../../shared/defaults'
import { restoreSecrets } from '../ipc/settings'
import { DIRS, readJson } from './storage'

/** 主对话和功能会话共用；密钥只在主进程本轮请求内使用。 */
export function readChatSettings(): Settings {
  const saved = readJson<Settings>(join(DIRS.config(), 'settings.json'), 'settings')
  if (!saved) return getDefaultSettings()
  restoreSecrets(saved)
  return { ...getDefaultSettings(), ...saved }
}

export { resolveChatProfile } from '../../shared/chatConnection'
