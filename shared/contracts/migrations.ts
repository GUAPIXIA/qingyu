/**
 * Payload schemaVersion 迁移注册表。
 * 只允许 N→N+1；确定性；幂等；不访问网络；未知高版本拒绝。
 */

export type MigrateFn = (payload: never) => never

export interface MigrationStep {
  from: number
  to: number
  entityType: string
  migrate: (payload: any) => any
}

export class MigrationRegistry {
  private readonly steps = new Map<string, MigrationStep[]>()

  register(step: MigrationStep): void {
    if (step.to !== step.from + 1) {
      throw new Error(`迁移只允许 N→N+1: ${step.from}→${step.to}`)
    }
    const key = step.entityType
    const list = this.steps.get(key) ?? []
    if (list.some((s) => s.from === step.from)) {
      throw new Error(`重复注册迁移 ${key} ${step.from}`)
    }
    list.push(step)
    list.sort((a, b) => a.from - b.from)
    this.steps.set(key, list)
  }

  /**
   * 迁移到 targetVersion。
   * @throws 未知高版本、缺步骤、当前版本高于目标
   */
  migrateTo<T>(entityType: string, payload: T, fromVersion: number, targetVersion: number): T {
    if (fromVersion > targetVersion) {
      throw new Error(`禁止降级迁移 ${entityType}: ${fromVersion}→${targetVersion}`)
    }
    if (fromVersion === targetVersion) return payload
    const list = this.steps.get(entityType) ?? []
    let current = fromVersion
    let value: any = payload
    while (current < targetVersion) {
      const step = list.find((s) => s.from === current)
      if (!step) {
        throw new Error(`缺少迁移步骤 ${entityType} ${current}→${current + 1}`)
      }
      value = step.migrate(value)
      current = step.to
    }
    return value as T
  }

  latestVersion(entityType: string): number {
    const list = this.steps.get(entityType) ?? []
    if (list.length === 0) return 1
    return list[list.length - 1].to
  }

  /** 内置空注册表工厂：仅登记契约示例用的 identity 步骤 */
  static identity(): MigrationRegistry {
    const r = new MigrationRegistry()
    return r
  }
}
