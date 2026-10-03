export type * from './model.ts'
export type * from './commands.ts'
export {
  IMPORT_LIMITS,
  OFFSTAGE_REGION_TAG,
  OFFSTAGE_REGION_NAME,
  OFFSTAGE_REGION_DESCRIPTION,
  OFFSTAGE_REGION_SIZE,
} from './model.ts'

export {
  getBoard,
  getNode,
  getNodesOnBoard,
  getAncestorChain,
  getContainmentPath,
  isAncestor,
  collectDescendants,
  validateHierarchy,
} from './hierarchy.ts'
export type { ValidationIssue } from './hierarchy.ts'
export { removeNodeCategories, stripNodeCategories } from './nodeFields.ts'
export { isPlaceSubstructure, validateSubstructures, removeSubstructureConflicts } from './substructures.ts'

export {
  undirectedPairKey,
  validateDistanceRelation,
  validateDistances,
} from './distance.ts'

export {
  validatePlacements,
  validatePlacementInput,
  buildPlacement,
  isPlacementOffstage,
} from './placement.ts'

export {
  validateWorld,
  validateRuntime,
  validateAll,
  hasErrors,
  formatIssues,
} from './validation.ts'

export {
  createRootBoard,
  createEmptyWorld,
  createWorldWithDefaults,
  createEmptyRuntime,
  createSeqIdGen,
} from './factory.ts'

export {
  applyCommandBatch,
  applyCommand,
} from './reducer.ts'
export type {
  SpatialCoreState,
  ApplyOptions,
  ApplyBatchResult,
  ApplySuccess,
  ApplyFailure,
} from './reducer.ts'

export {
  createHistory,
  runBatch,
  undo,
  redo,
  canUndo,
  canRedo,
} from './history.ts'
export type { HistoryState, HistoryEntry, RunResult } from './history.ts'

export {
  projectCompactText,
  exportWorldJson,
  exportRuntimeJson,
  summarizeActorsOnAncestors,
  formatDistanceKey,
} from './projection.ts'
export type { ProjectionOptions, AncestorActorSummary } from './projection.ts'

export { migrateWorldDocument, migrateRuntimeState } from './migrations.ts'
export type { MigrationResult } from './migrations.ts'

// 导入防护（阶段 2 从 spatial-board/src/persistence/importGuard.ts 迁入；
// 纯文本/结构校验，File/Blob 与文件选择留在编辑器侧）
export {
  parseImportJson,
  guardWorldImport,
  guardRuntimeImport,
  formatImportIssues,
  measureNodeDepth,
} from './importGuard.ts'
export type { ImportLimitIssue, ImportGuardOptions } from './importGuard.ts'
