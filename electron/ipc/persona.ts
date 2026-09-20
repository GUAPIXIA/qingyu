import type { IpcMain } from 'electron'
import { join } from 'node:path'
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { DIRS, withFileLock, serializeJson } from '../services/storage'
import { createLogger } from '../services/logger'
import type { Persona } from '../../shared/types'
import { nanoid } from 'nanoid'
import { commitThroughDomain } from '../domain/syncDomainService'

const log = createLogger('persona')

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

/** 人设实体的规范 payload：与阶段 1 冻结字段及 S2-05 扫描器一致（不含 id/头像/时间戳） */
export function personaEntityPayload(persona: Persona): Record<string, unknown> {
  return {
    name: persona.name,
    description: persona.description,
    persona: persona.persona,
  }
}

/**
 * 阶段 2 S2-04：personas.json 与其 journal 在同一文件事务内提交。
 * 以磁盘旧状态为基准 diff 出新增/内容变化的人设实体与被移除的实体，
 * flag 关闭时入口内部退化为与旧实现一致的原子落盘（同目录 tmp + rename）。
 */
function writePersonas(personas: Persona[]): void {
  const path = getPersonasPath()
  const previous = readPersonas()
  const previousPayloadById = new Map(
    previous.map((p) => [p.id, JSON.stringify(personaEntityPayload(p))]),
  )
  const nextIds = new Set(personas.map((p) => p.id))

  const puts = personas
    .filter((p) => previousPayloadById.get(p.id) !== JSON.stringify(personaEntityPayload(p)))
    .map((p) => ({ entityId: p.id, payload: personaEntityPayload(p), schemaVersion: 1 }))
  const deletes = previous
    .filter((p) => !nextIds.has(p.id))
    .map((p) => ({ entityId: p.id }))

  commitThroughDomain({
    domain: 'persona',
    entityType: 'persona',
    puts,
    deletes,
    files: [{ path, content: serializeJson(personas) }],
  })
}

export function registerPersonaIPC(ipcMain: IpcMain): void {
  // 列出所有身份
  ipcMain.handle('persona:list', async () => {
    return readPersonas()
  })

  // 保存身份（新增或更新）
  ipcMain.handle('persona:save', async (_e, persona: Persona) => {
    // M-14 修复：读-改-写加文件锁，并发 save 不再后写覆盖先写（静默丢更新）
    return withFileLock(getPersonasPath(), () => {
      const personas = readPersonas()
      const idx = personas.findIndex((p) => p.id === persona.id)
      persona.updatedAt = Date.now()
      if (idx >= 0) {
        personas[idx] = persona
      } else {
        personas.push(persona)
      }
      writePersonas(personas)
      log.info('身份已保存', { id: persona.id, name: persona.name })
      return persona
    })
  })

  // 删除身份
  ipcMain.handle('persona:delete', async (_e, id: string) => {
    const personas = readPersonas().filter((p) => p.id !== id)
    writePersonas(personas)
    log.info('身份已删除', { id })
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
    log.info('默认身份已创建', { id: persona.id, name: persona.name })
    return persona
  })
}
