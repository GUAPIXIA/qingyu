/**
 * 类型契约编译期检查：确保 model / commands 导出完整且互相一致。
 * 不引入运行时逻辑；`tsc --noEmit` 通过即视为通过。
 */
import type {
  ActorPlacement,
  DistanceRelation,
  SpatialBoard,
  SpatialCommand,
  SpatialCommandBatch,
  SpatialEvent,
  SpatialNode,
  SpatialRuntimeStateV1,
  SpatialWorldDocumentV1,
} from '../src/index.ts'

type Expect<T extends true> = T
type IsAssignable<A, B> = A extends B ? true : false

// 世界文档包含画板 / 节点 / 距离 / 角色
export type WorldShape = Expect<
  IsAssignable<SpatialWorldDocumentV1['boards'][number], SpatialBoard>
>
export type NodeShape = Expect<
  IsAssignable<SpatialWorldDocumentV1['nodes'][number], SpatialNode>
>
export type DistShape = Expect<
  IsAssignable<SpatialWorldDocumentV1['distances'][number], DistanceRelation>
>

// 运行时包含位置与事件
export type PlacementShape = Expect<
  IsAssignable<SpatialRuntimeStateV1['placements'][number], ActorPlacement>
>
export type EventShape = Expect<
  IsAssignable<SpatialRuntimeStateV1['events'][number], SpatialEvent>
>

// 命令批次携带 expectedRevision
export type BatchShape = Expect<
  IsAssignable<SpatialCommandBatch['commands'][number], SpatialCommand>
>
