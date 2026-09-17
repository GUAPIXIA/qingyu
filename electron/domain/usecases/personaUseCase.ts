import { PcDomainRepository } from '../pcRepository'
import { RepoFeatureFlags, type DomainFlagKey } from '../featureFlag'
import type { DomainWriteFile } from '../types'

export interface PersonaRecord {
  id: string
  name: string
  description: string
  persona: string
  avatar?: string
  createdAt?: number
  updatedAt?: number
}

function serialize(list: PersonaRecord[]): string {
  return JSON.stringify(list, null, 2)
}

/**
 * persona 域 use case：flag 开启时经 Repository 在同一事务内落盘 + 写 journal；
 * 关闭时只落盘（与旧行为一致）。
 */
export function savePersonaThroughRepo(
  repo: PcDomainRepository,
  flags: RepoFeatureFlags,
  persona: PersonaRecord,
): { journaled: boolean } {
  const file = repo.configPath('personas.json')
  const list = repo.readJsonFile<PersonaRecord[]>(file) ?? []
  const idx = list.findIndex((p: PersonaRecord) => p.id === persona.id)
  const merged: PersonaRecord = { ...persona, updatedAt: Date.now() }
  const next = idx >= 0 ? list.map((p: PersonaRecord) => (p.id === persona.id ? merged : p)) : [...list, merged]
  const files: DomainWriteFile[] = [{ path: file, content: serialize(next) }]

  if (!flags.isEnabled('persona')) {
    repo.writeJsonAtomic(file, next)
    return { journaled: false }
  }

  repo.putWithJournal({
    entityType: 'persona',
    entityId: persona.id,
    payload: {
      name: persona.name,
      description: persona.description,
      persona: persona.persona,
    },
    schemaVersion: 1,
    files,
  })
  return { journaled: true }
}

export function deletePersonaThroughRepo(
  repo: PcDomainRepository,
  flags: RepoFeatureFlags,
  id: string,
): { journaled: boolean } {
  const file = repo.configPath('personas.json')
  const list = repo.readJsonFile<PersonaRecord[]>(file) ?? []
  const next = list.filter((p: PersonaRecord) => p.id !== id)
  const files: DomainWriteFile[] = [{ path: file, content: serialize(next) }]

  if (!flags.isEnabled('persona')) {
    repo.writeJsonAtomic(file, next)
    return { journaled: false }
  }

  repo.tombstoneWithJournal({
    entityType: 'persona',
    entityId: id,
    files,
  })
  return { journaled: true }
}

export const SETTINGS_PUBLIC_DOMAIN: DomainFlagKey = 'settings_public'
