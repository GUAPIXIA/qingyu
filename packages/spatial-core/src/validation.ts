/**
 * 世界定义 / 运行状态的完整校验编排。
 * 三个校验器：hierarchy（hierarchy.ts）、distance、placement。
 */
import type {
  SpatialRuntimeStateV1,
  SpatialWorldDocumentV1,
} from './model.ts'
import { validateHierarchy, type ValidationIssue } from './hierarchy.ts'
import { validateDistances } from './distance.ts'
import { validatePlacements } from './placement.ts'

export type { ValidationIssue }

export function validateWorld(
  world: SpatialWorldDocumentV1
): ValidationIssue[] {
  return [
    ...validateHierarchy(world),
    ...validateDistances(world),
  ]
}

export function validateRuntime(
  world: SpatialWorldDocumentV1,
  runtime: SpatialRuntimeStateV1
): ValidationIssue[] {
  const issues = validatePlacements(world, runtime)
  if (runtime.worldId !== world.id) {
    issues.unshift({
      code: 'runtime_world_mismatch',
      message: `运行状态属于世界 ${runtime.worldId}，当前世界为 ${world.id}`,
      subjectId: runtime.runtimeId,
      severity: 'error',
    })
  }
  return issues
}

export function validateAll(
  world: SpatialWorldDocumentV1,
  runtime: SpatialRuntimeStateV1
): ValidationIssue[] {
  return [...validateWorld(world), ...validateRuntime(world, runtime)]
}

export function hasErrors(issues: ValidationIssue[]): boolean {
  return issues.some((i) => i.severity === 'error')
}

export function formatIssues(issues: ValidationIssue[]): string {
  return issues
    .map((i) => `[${i.severity}] ${i.code}: ${i.message}`)
    .join('\n')
}
