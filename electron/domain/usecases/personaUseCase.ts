import { PcDomainRepository } from '../pcRepository'
import { RepoFeatureFlags, type DomainFlagKey } from '../featureFlag'

export interface PersonaRecord {
  id: string
  name: string
  description: string
  persona: string
  avatar?: string
  createdAt?: number
  updatedAt?: number
}

/**
 * persona 域 use case：flag 开启时经 Repository 写 journal；关闭时仍写旧 JSON 数组文件（兼容）。
 */
export function savePersonaThroughRepo(
  repo: PcDomainRepository,
  flags: RepoFeatureFlags,
  persona: PersonaRecord,
): { journaled: boolean } {
  if (!flags.isEnabled('persona')) {
    // 旧路径仍由 IPC 直接写；本函数在 flag 关闭时只更新文件（与旧行为一致）
    const file = repo.configPath('personas.json')
    const list = repo.readJsonFile<PersonaRecord[]>(file) ?? []
    const idx = list.findIndex((p: PersonaRecord) => p.id === persona.id)
    const next = idx >= 0 ? list.map((p: PersonaRecord) => (p.id === persona.id ? persona : p)) : [...list, persona]
    repo.writeJsonAtomic(file, next)
    return { journaled: false }
  }

  const file = repo.configPath('personas.json')
  repo.putWithJournal({
    entityType: 'persona',
    entityId: persona.id,
    payload: {
      name: persona.name,
      description: persona.description,
      persona: persona.persona,
    },
    schemaVersion: 1,
    writeBusiness: () => {
      const list = repo.readJsonFile<PersonaRecord[]>(file) ?? []
      const idx = list.findIndex((p: PersonaRecord) => p.id === persona.id)
      const merged: PersonaRecord = {
        ...persona,
        updatedAt: Date.now(),
      }
      const next = idx >= 0 ? list.map((p: PersonaRecord) => (p.id === persona.id ? merged : p)) : [...list, merged]
      repo.writeJsonAtomic(file, next)
    },
  })
  return { journaled: true }
}

export function deletePersonaThroughRepo(
  repo: PcDomainRepository,
  flags: RepoFeatureFlags,
  id: string,
): { journaled: boolean } {
  const file = repo.configPath('personas.json')
  if (!flags.isEnabled('persona')) {
    const list = repo.readJsonFile<PersonaRecord[]>(file) ?? []
    repo.writeJsonAtomic(file, list.filter((p: PersonaRecord) => p.id !== id))
    return { journaled: false }
  }
  repo.tombstoneWithJournal({
    entityType: 'persona',
    entityId: id,
    deleteBusiness: () => {
      const list = repo.readJsonFile<PersonaRecord[]>(file) ?? []
      repo.writeJsonAtomic(file, list.filter((p: PersonaRecord) => p.id !== id))
    },
  })
  return { journaled: true }
}

export const SETTINGS_PUBLIC_DOMAIN: DomainFlagKey = 'settings_public'
