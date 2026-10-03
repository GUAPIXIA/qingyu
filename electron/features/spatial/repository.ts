import { createHash } from 'node:crypto'
import { existsSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
// eslint-disable-next-line no-restricted-imports
import { createEmptyRuntime, removeNodeCategories, removeSubstructureConflicts, validateAll } from '@qingyu/spatial-core'
// eslint-disable-next-line no-restricted-imports
import { guardRuntimeImport, guardWorldImport } from '@qingyu/spatial-core'
// eslint-disable-next-line no-restricted-imports
import type { SpatialCommand, SpatialCoreState, SpatialWorldDocumentV1 } from '@qingyu/spatial-core'
import type { SpatialCommitReceipt } from '../../../shared/spatial'
import { safeId } from '../../utils/pathGuard'
import { DIRS, readJson, withFileLock, writeJson } from '../../services/storage'

export interface SpatialScope { kind?: 'single'; characterId: string; sessionId: string }
export interface SpatialGroupScope { kind: 'group'; groupId: string; sessionId: string }
export type SpatialOwnerScope = SpatialScope | SpatialGroupScope
export const isGroupScope = (scope: SpatialOwnerScope): scope is SpatialGroupScope => scope.kind === 'group'
export function validateSpatialScope(scope: SpatialOwnerScope): void {
  if (!scope || (scope.kind !== undefined && scope.kind !== 'single' && scope.kind !== 'group')) throw new Error('空间会话范围无效')
  if (isGroupScope(scope)) {
    if ('characterId' in scope) throw new Error('群聊范围不能包含单聊角色')
    safeId(scope.groupId)
  } else {
    if ('groupId' in scope) throw new Error('单聊范围不能包含群聊')
    safeId(scope.characterId)
  }
  safeId(scope.sessionId)
}
export const spatialRuntimeId = (scope: SpatialOwnerScope): string => isGroupScope(scope)
  ? `group_${hashSpatialValue({ groupId: scope.groupId, sessionId: scope.sessionId }).slice(0, 32)}` : `single_${scope.sessionId}`
export interface SpatialBinding { worldId: string | null; runtimeId: string | null }
export interface SpatialSessionState {
  schemaVersion: 1
  worldId: string
  runtimeId: string
  bindingEpoch: string
  initialization?: { commitId: string; mode: 'generated' | 'blank' | 'bound'; sourceFingerprint?: string; createdAt: number }
  commits: Record<string, { requestHash: string; receipt: SpatialCommitReceipt; inverse: SpatialCommand[] }>
}
interface BindingPort {
  read(scope: SpatialOwnerScope): Promise<SpatialBinding>
  compareAndSet(scope: SpatialOwnerScope, before: SpatialBinding, after: SpatialBinding): Promise<void>
}
type FileKind = 'world' | 'runtime' | 'state' | 'ai'
interface Transaction {
  schemaVersion: 1
  id: string
  scope: SpatialOwnerScope
  worldId: string
  aiSessionId?: string
  binding?: { before: SpatialBinding; after: SpatialBinding }
  files: Array<{ kind: FileKind; beforeHash: string | null; afterHash: string; after: unknown }>
}

/** 对对象键稳定排序；数组保留领域顺序。 */
export function stableStringify(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize)
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, normalize(child)]))
    }
    return item
  }
  return JSON.stringify(normalize(value))
}
export const hashSpatialValue = (value: unknown): string =>
  createHash('sha256').update(stableStringify(value)).digest('hex')

export function worldFingerprint(world: SpatialWorldDocumentV1): string {
  const { metadata: _metadata, ...content } = world
  return hashSpatialValue({
    ...content,
    boards: world.boards.map(({ viewportHint: _viewport, ...board }) => board)
      .sort((a, b) => a.id.localeCompare(b.id)),
    nodes: [...world.nodes].sort((a, b) => a.id.localeCompare(b.id)),
    distances: [...world.distances].sort((a, b) => a.id.localeCompare(b.id)),
    actors: world.actors.map(({ avatarAssetRef: _avatar, ...actor }) => actor)
      .sort((a, b) => a.id.localeCompare(b.id)),
  })
}

export const spatialPaths = {
  world: (id: string) => join(DIRS.spatial(), 'worlds', `${safeId(id)}.json`),
  runtime: (scope: SpatialOwnerScope) => join(DIRS.spatial(), isGroupScope(scope) ? 'group-runtimes' : 'runtimes', safeId(isGroupScope(scope) ? scope.groupId : scope.characterId), `${safeId(scope.sessionId)}.json`),
  state: (scope: SpatialOwnerScope) => join(DIRS.spatial(), isGroupScope(scope) ? 'group-session-state' : 'session-state', safeId(isGroupScope(scope) ? scope.groupId : scope.characterId), `${safeId(scope.sessionId)}.json`),
  ai: (id: string) => join(DIRS.spatial(), 'ai-sessions', `${safeId(id)}.json`),
  transaction: (id: string) => join(DIRS.spatial(), 'transactions', `${safeId(id)}.json`),
}

export function readSpatialJson<T>(path: string): T | null {
  const value = readJson<T>(path)
  if (value === null && existsSync(path)) throw new Error('空间数据损坏，已停止操作以避免覆盖')
  return value
}

export function validateSpatialPackage(state: SpatialCoreState): void {
  const { world, runtime } = state
  if (!world || !runtime || world.schemaVersion !== 1 || runtime.schemaVersion !== 1 ||
    !Array.isArray(world.boards) || !Array.isArray(world.nodes) || !Array.isArray(world.distances) ||
    !Array.isArray(world.actors) || !Array.isArray(runtime.placements) || !Array.isArray(runtime.events) ||
    !world.metadata || world.metadata.app !== 'qingyu-spatial-board' ||
    !Number.isSafeInteger(runtime.revision) || runtime.revision < 0) throw new Error('画板数据结构无效')
  safeId(world.id)
  safeId(runtime.runtimeId)
  if (Buffer.byteLength(JSON.stringify(world)) > 5 * 1024 * 1024 ||
    Buffer.byteLength(JSON.stringify(runtime)) > 5 * 1024 * 1024) throw new Error('画板数据超过 5 MiB 上限')
  const issue = [...guardWorldImport(world), ...guardRuntimeImport(runtime, world),
    ...validateAll(world, runtime).filter((item) => item.severity === 'error')][0]
  if (issue) throw new Error(`画板数据无效：${issue.message}`)
}

/** 一个空间锁覆盖一致读取、提交和恢复；单文件仍使用原子替换。 */
export class SpatialRepository {
  constructor(private readonly bindings: BindingPort) {}

  locked<T>(operation: () => T | Promise<T>): Promise<T> {
    return withFileLock(join(DIRS.spatial(), '.spatial-write-lock'), async () => {
      await this.recoverLocked()
      this.removeLegacyWorldFieldsLocked()
      return operation()
    })
  }

  /** 先清理所有共享会话引用，再写世界；中途退出后可按旧世界重复清理。 */
  private removeLegacyWorldFieldsLocked(): void {
    const root = join(DIRS.spatial(), 'worlds')
    if (!existsSync(root)) return
    for (const file of readdirSync(root).filter(name => name.endsWith('.json'))) {
      const world = readSpatialJson<SpatialWorldDocumentV1>(join(root, file))
      if (!world || file !== `${safeId(world.id)}.json`) throw new Error('空间世界记录无效')
      const now = Date.now()
      const categories = removeNodeCategories(world)
      const cleaned = removeSubstructureConflicts({ world: categories.world, runtime: createEmptyRuntime(world.id, 'migration', now) }, now)
      if (!cleaned.worldChanged && !categories.changed) continue
      validateSpatialPackage(cleaned.state)
      const runtimes = this.runtimes().filter(item => item.runtime.worldId === world.id).map(item => {
        const result = removeSubstructureConflicts({ world: categories.world, runtime: item.runtime }, now)
        validateSpatialPackage(result.state)
        return { scope: item.scope, result }
      })
      for (const { scope, result } of runtimes) {
        if (result.runtimeChanged) writeJson(spatialPaths.runtime(scope), result.state.runtime)
      }
      writeJson(spatialPaths.world(world.id), cleaned.state.world)
    }
  }

  /** 整库恢复可替换损坏的旧事务；恢复结束后再核对备份内的事务。 */
  lockedForRestore<T>(operation: () => T | Promise<T>): Promise<T> {
    return withFileLock(join(DIRS.spatial(), '.spatial-write-lock'), operation)
  }

  private target(tx: Transaction, kind: FileKind): string {
    if (kind === 'world') return spatialPaths.world(tx.worldId)
    if (kind === 'runtime') return spatialPaths.runtime(tx.scope)
    if (kind === 'state') return spatialPaths.state(tx.scope)
    if (kind === 'ai' && tx.aiSessionId) return spatialPaths.ai(tx.aiSessionId)
    throw new Error('空间事务目标无效')
  }

  private async finish(tx: Transaction): Promise<void> {
    if (tx.schemaVersion !== 1 || !Array.isArray(tx.files) || tx.files.length < 2 || tx.files.length > 4 ||
      new Set(tx.files.map((file) => file.kind)).size !== tx.files.length) throw new Error('空间事务记录无效')
    safeId(tx.id)
    safeId(tx.worldId)
    validateSpatialScope(tx.scope)
    if (isGroupScope(tx.scope) && (tx.files.length !== (tx.aiSessionId ? 4 : 3) || !['world', 'runtime', 'state', ...(tx.aiSessionId ? ['ai'] : [])].every(kind => tx.files.some(file => file.kind === kind)))) throw new Error('群聊空间事务必须包含世界、位置和提交记录')
    if (isGroupScope(tx.scope) && tx.aiSessionId) {
      const ai = tx.files.find(file => file.kind === 'ai')?.after as import('../../../shared/spatial-ai').SpatialGroupAiSession
      if (ai?.id !== tx.aiSessionId || ai.scope?.kind !== 'group' || ai.scope.groupId !== tx.scope.groupId || ai.scope.sessionId !== tx.scope.sessionId || ai.scope.worldId !== tx.worldId) throw new Error('群聊助手事务归属无效')
    }
    if (tx.binding) {
      const current = await this.bindings.read(tx.scope)
      if (hashSpatialValue(current) !== hashSpatialValue(tx.binding.before) &&
        hashSpatialValue(current) !== hashSpatialValue(tx.binding.after)) {
        throw new Error('空间事务绑定已改变，请核对恢复记录')
      }
    }
    // 先核对全部文件，再写任何一个，避免恢复覆盖后来产生的数据。
    for (const file of tx.files) {
      if (hashSpatialValue(file.after) !== file.afterHash) throw new Error('空间事务内容校验失败')
      const current = readSpatialJson<unknown>(this.target(tx, file.kind))
      const currentHash = current === null ? null : hashSpatialValue(current)
      if (currentHash !== file.beforeHash && currentHash !== file.afterHash) {
        throw new Error('空间事务与当前数据不匹配，请核对恢复记录')
      }
    }
    for (const file of tx.files) {
      const target = this.target(tx, file.kind)
      const current = readSpatialJson<unknown>(target)
      if (current === null || hashSpatialValue(current) !== file.afterHash) writeJson(target, file.after)
    }
    if (tx.binding) await this.bindings.compareAndSet(tx.scope, tx.binding.before, tx.binding.after)
    unlinkSync(spatialPaths.transaction(tx.id))
  }

  private async recoverLocked(): Promise<void> {
    const directory = join(DIRS.spatial(), 'transactions')
    if (!existsSync(directory)) return
    for (const file of readdirSync(directory).filter((name) => name.endsWith('.json')).sort()) {
      const tx = readSpatialJson<Transaction>(join(directory, file))
      if (!tx || file !== `${safeId(tx.id)}.json`) throw new Error('空间事务记录无效')
      await this.finish(tx)
    }
  }

  async persist(scope: SpatialOwnerScope, worldId: string, id: string,
    values: Partial<Record<FileKind, unknown>>, binding?: Transaction['binding'], aiSessionId?: string): Promise<void> {
    if (!binding) {
      const current = await this.bindings.read(scope)
      const runtime = values.runtime as SpatialCoreState['runtime'] | undefined
      if (current.worldId !== worldId || (current.runtimeId && current.runtimeId !== runtime?.runtimeId)) {
        throw new Error('空间事务绑定已改变')
      }
      binding = { before: current, after: current }
    }
    const tx: Transaction = { schemaVersion: 1, id: safeId(id), scope, worldId, binding, aiSessionId, files: [] }
    for (const [kind, after] of Object.entries(values) as Array<[FileKind, unknown]>) {
      const before = readSpatialJson<unknown>(this.target(tx, kind))
      tx.files.push({ kind, beforeHash: before === null ? null : hashSpatialValue(before), afterHash: hashSpatialValue(after), after })
    }
    writeJson(spatialPaths.transaction(tx.id), tx)
    await this.finish(tx)
  }

  /** 包括共享世界的其他会话；损坏的运行状态不能被悄悄跳过。 */
  runtimes(): Array<{ scope: SpatialOwnerScope; runtime: SpatialCoreState['runtime'] }> {
    const result: Array<{ scope: SpatialOwnerScope; runtime: SpatialCoreState['runtime'] }> = []
    for (const kind of ['single', 'group'] as const) {
      const root = join(DIRS.spatial(), kind === 'group' ? 'group-runtimes' : 'runtimes')
      if (!existsSync(root)) continue
      for (const directory of readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
        for (const file of readdirSync(join(root, directory.name)).filter((name) => name.endsWith('.json'))) {
          const sessionId = safeId(file.slice(0, -5))
          const scope: SpatialOwnerScope = kind === 'group'
            ? { kind, groupId: safeId(directory.name), sessionId } : { characterId: safeId(directory.name), sessionId }
          const runtime = readSpatialJson<SpatialCoreState['runtime']>(spatialPaths.runtime(scope))
          if (runtime) result.push({ scope, runtime })
        }
      }
    }
    return result
  }
}
