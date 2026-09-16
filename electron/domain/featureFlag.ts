import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 按数据域的 Repository 接管开关。同步域一旦开启不得在线切回旧写入口。 */
export type DomainFlagKey =
  | 'settings_public'
  | 'persona'
  | 'regex_rule'
  | 'quick_reply_set'
  | 'preset'
  | 'lorebook'
  | 'character'
  | 'session'
  | 'message'
  | 'group'
  | 'usage_record'
  | 'mcp_public_config'

export type RepoFlags = Record<DomainFlagKey, boolean>

const DEFAULT_FLAGS: RepoFlags = {
  settings_public: false,
  persona: false,
  regex_rule: false,
  quick_reply_set: false,
  preset: false,
  lorebook: false,
  character: false,
  session: false,
  message: false,
  group: false,
  usage_record: false,
  mcp_public_config: false,
}

export class RepoFeatureFlags {
  constructor(private readonly filePath: string) {}

  read(): RepoFlags {
    if (!existsSync(this.filePath)) return { ...DEFAULT_FLAGS }
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<RepoFlags>
      return { ...DEFAULT_FLAGS, ...parsed }
    } catch {
      return { ...DEFAULT_FLAGS }
    }
  }

  isEnabled(domain: DomainFlagKey): boolean {
    return this.read()[domain] === true
  }

  set(domain: DomainFlagKey, enabled: boolean): RepoFlags {
    const next = { ...this.read(), [domain]: enabled }
    this.persist(next)
    return next
  }

  private persist(flags: RepoFlags): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    writeFileSync(this.filePath, JSON.stringify(flags, null, 2), 'utf8')
  }
}

export function defaultFlagsPath(userDataDir: string): string {
  return joinConfig(userDataDir)
}

function joinConfig(userDataDir: string): string {
  return `${userDataDir.replace(/[\\/]+$/, '')}/data/config/sync-repo-flags.json`
}
