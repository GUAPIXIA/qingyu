import type { IpcMain } from 'electron'
import { join } from 'node:path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { DIRS } from '../services/storage'
import type { Persona } from '../../shared/types'
import { nanoid } from 'nanoid'

function getPersonasPath(): string {
  const dir = DIRS.config()
  mkdirSync(dir, { recursive: true })
  return join(dir, 'personas.json')
}

function readPersonas(): Persona[] {
  const path = getPersonasPath()
  if (!existsSync(path)) return []
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Persona[]
  } catch {
    return []
  }
}

function writePersonas(personas: Persona[]): void {
  writeFileSync(getPersonasPath(), JSON.stringify(personas, null, 2), 'utf-8')
}

export function registerPersonaIPC(ipcMain: IpcMain): void {
  // 列出所有身份
  ipcMain.handle('persona:list', async () => {
    return readPersonas()
  })

  // 保存身份（新增或更新）
  ipcMain.handle('persona:save', async (_e, persona: Persona) => {
    const personas = readPersonas()
    const idx = personas.findIndex((p) => p.id === persona.id)
    persona.updatedAt = Date.now()
    if (idx >= 0) {
      personas[idx] = persona
    } else {
      personas.push(persona)
    }
    writePersonas(personas)
    return persona
  })

  // 删除身份
  ipcMain.handle('persona:delete', async (_e, id: string) => {
    const personas = readPersonas().filter((p) => p.id !== id)
    writePersonas(personas)
  })

  // 创建默认身份（首次使用）
  ipcMain.handle('persona:createDefault', async (_e, name: string) => {
    const persona: Persona = {
      id: nanoid(),
      name: name || '用户',
      description: '',
      persona: '',
      avatar: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    const personas = readPersonas()
    personas.push(persona)
    writePersonas(personas)
    return persona
  })
}
