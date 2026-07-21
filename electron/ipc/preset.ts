import type { IpcMain, Dialog } from 'electron'
import { join } from 'node:path'
import { DIRS, writeJson, readJson, listJsonFiles, removeFile } from '../services/storage'
import { createLogger } from '../services/logger'
import type { Preset } from '../../shared/types'
import { nanoid } from 'nanoid'
import { safeId } from '../utils/pathGuard'

const log = createLogger('preset')

/** 内置预设 */
export function getBuiltinPresets(): Preset[] {
  return [
    {
      id: 'builtin-default',
      name: '默认预设',
      description: '适合大多数对话场景的通用预设',
      systemPrompt: '你是一个角色扮演助手。请根据角色设定进行沉浸式对话，保持角色性格的一致性。使用中文回复。',
      jailbreak: '',
      maxContext: 8192,
      temperature: 0.8,
      topP: 0.95,
      maxTokens: 1024,
      frequencyPenalty: 0,
      presencePenalty: 0,
      isBuiltin: true,
    },
    {
      id: 'builtin-creative',
      name: '创意写作',
      description: '更高的随机性，适合创意写作和发散剧情',
      systemPrompt: '你是一个富有创造力的角色扮演助手。请大胆发挥想象，推动剧情发展，描写生动细腻。使用中文回复。',
      jailbreak: '',
      maxContext: 8192,
      temperature: 1.1,
      topP: 0.98,
      maxTokens: 1536,
      frequencyPenalty: 0.3,
      presencePenalty: 0.3,
      isBuiltin: true,
    },
    {
      id: 'builtin-precise',
      name: '精准对话',
      description: '较低的随机性，适合严肃或信息密集的对话',
      systemPrompt: '你是一个严谨的角色扮演助手。请准确理解角色设定，保持逻辑清晰，回复简洁有力。使用中文回复。',
      jailbreak: '',
      maxContext: 8192,
      temperature: 0.5,
      topP: 0.9,
      maxTokens: 1024,
      frequencyPenalty: 0,
      presencePenalty: 0,
      isBuiltin: true,
    },
  ]
}

export function registerPresetIPC(ipcMain: IpcMain, dialog: Dialog): void {
  // 列表（包含内置预设）
  ipcMain.handle('preset:list', async () => {
    const custom = listJsonFiles<Preset>(DIRS.presets())
    const builtin = getBuiltinPresets()
    return [...builtin, ...custom]
  })

  // 保存
  ipcMain.handle('preset:save', async (_e, preset: Preset) => {
    if (preset.isBuiltin) {
      // 内置预设不可修改，创建副本
      preset.id = nanoid()
      preset.name = `${preset.name} (副本)`
      preset.isBuiltin = false
    }
    safeId(preset.id)
    writeJson(join(DIRS.presets(), `${preset.id}.json`), preset)
    log.info('预设已保存', { id: preset.id, name: preset.name })
    return preset
  })

  // 删除
  ipcMain.handle('preset:delete', async (_e, id: string) => {
    safeId(id)
    removeFile(join(DIRS.presets(), `${id}.json`))
    log.info('预设已删除', { id })
  })

  // 导入
  ipcMain.handle('preset:importJson', async () => {
    const result = await dialog.showOpenDialog({
      title: '导入预设',
      filters: [{ name: 'JSON 文件', extensions: ['json'] }],
      properties: ['openFile'],
    })
    if (result.canceled || result.filePaths.length === 0) return null

    const { readFileSync } = require('node:fs')
    const parsed = JSON.parse(readFileSync(result.filePaths[0], 'utf-8'))
    const preset: Preset = {
      id: nanoid(),
      name: parsed.name ?? '导入的预设',
      description: parsed.description ?? '',
      systemPrompt: parsed.systemPrompt ?? parsed.prompts?.find((p: any) => p.name === 'main')?.content ?? '',
      jailbreak: parsed.jailbreak ?? parsed.prompts?.find((p: any) => p.name === 'jailbreak')?.content ?? '',
      maxContext: parsed.maxContext ?? 8192,
      temperature: parsed.temperature ?? 0.8,
      topP: parsed.topP ?? 0.95,
      maxTokens: parsed.maxTokens ?? 1024,
      frequencyPenalty: parsed.frequencyPenalty ?? 0,
      presencePenalty: parsed.presencePenalty ?? 0,
      isBuiltin: false,
    }
    writeJson(join(DIRS.presets(), `${preset.id}.json`), preset)
    log.info('预设已导入', { name: preset.name })
    return preset
  })
}
