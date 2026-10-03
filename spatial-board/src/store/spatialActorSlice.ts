/**
 * 画板 slice：角色与放置（结构阶段 4C 自 spatialStore.ts 拆出）。
 *
 * 角色锚点变化会经 anchorRowCommands 预演所在行的重排命令，与放置/移动/移出一并提交。
 */
import { runBatch } from '@qingyu/spatial-core'
import { nextFreeActorPosition } from '../canvas/adapter.ts'
import {
  anchorRowCommands,
  newId,
  now,
  roundCanvas,
} from './spatialStoreHelpers.ts'
import type {
  SpatialStore,
  SpatialStoreGet,
  SpatialStoreSet,
} from './spatialStoreTypes.ts'

export type SpatialActorActions = Pick<SpatialStore,
  | 'createActor' | 'updateActor' | 'deleteActor' | 'placeActorAt'
  | 'placeActorOnBoard' | 'moveActorTo' | 'removeActorFromBoard'>

export function createSpatialActorSlice(set: SpatialStoreSet, get: SpatialStoreGet): SpatialActorActions {
  return {
    createActor: (displayName, kind = 'character') => {
      const { core, idGen, history } = get()
      const id = newId('actor', idGen)
      const result = runBatch(
        core,
        history,
        {
          schemaVersion: 1,
          expectedRevision: core.runtime.revision,
          commands: [
            {
              type: 'create_actor',
              payload: {
                id,
                kind,
                externalRef: { type: 'standalone', id },
                displayName: displayName.trim() || '新角色',
              },
            },
          ],
        },
        { now: now(), source: 'user', idGen, label: 'create-actor' }
      )
      if (!result.batch.ok) {
        set({ statusMessage: `创建角色失败：${result.batch.code}` })
        return null
      }
      set({
        core: result.batch.state,
        history: result.history,
        selection: { type: 'actor', id },
        saveStatus: 'saving',
        statusMessage: `已添加角色「${displayName}」`,
      })
      return id
    },

    updateActor: (actorId, patch) => {
      const { core, idGen, history } = get()
      const result = runBatch(
        core,
        history,
        {
          schemaVersion: 1,
          expectedRevision: core.runtime.revision,
          commands: [{ type: 'update_actor', actorId, patch }],
        },
        { now: now(), source: 'user', idGen, label: 'update-actor' }
      )
      if (!result.batch.ok) {
        set({ statusMessage: `更新角色失败：${result.batch.code}` })
        return
      }
      set({
        core: result.batch.state,
        history: result.history,
        saveStatus: 'saving',
      })
    },

    deleteActor: (actorId) => {
      if (get().activeActorIds !== null) { set({ statusMessage: '请在群聊设置中管理成员' }); return }
      const { core, idGen, history } = get()
      const result = runBatch(
        core,
        history,
        {
          schemaVersion: 1,
          expectedRevision: core.runtime.revision,
          commands: [{ type: 'delete_actor', actorId }],
        },
        { now: now(), source: 'user', idGen, label: 'delete-actor' }
      )
      if (!result.batch.ok) {
        set({ statusMessage: `删除角色失败：${result.batch.code}` })
        return
      }
      set({
        core: result.batch.state,
        history: result.history,
        selection: { type: 'none', id: null },
        saveStatus: 'saving',
        statusMessage: '已删除角色',
      })
    },

    placeActorAt: (actorId, boardId, x, y, anchor, semantic) => {
      const { core, idGen, history } = get()
      const prev = core.runtime.placements.find((p) => p.actorId === actorId)
      const prevAnchorId =
        prev?.anchor.kind === 'node' ? (prev.anchor.nodeId ?? null) : null
      const nextAnchorId = anchor?.kind === 'node' ? (anchor.nodeId ?? null) : null
      const rowCommands = anchorRowCommands(core, prevAnchorId, nextAnchorId)
      const result = runBatch(
        core,
        history,
        {
          schemaVersion: 1,
          expectedRevision: core.runtime.revision,
          commands: [
            {
              type: 'place_actor',
              actorId,
              placement: {
                boardId,
                anchor: anchor ?? { kind: 'board' },
                position: {
                  x: roundCanvas(x),
                  y: roundCanvas(y),
                },
                semanticPosition: {
                  precision: (semantic?.precision as never) ?? 'approximate',
                  ...(semantic?.relativeDirection
                    ? { relativeDirection: semantic.relativeDirection as never }
                    : {}),
                  ...(semantic?.note ? { note: semantic.note } : {}),
                },
              },
            },
            ...rowCommands,
          ],
        },
        { now: now(), source: 'user', idGen, label: 'place-actor' }
      )
      if (!result.batch.ok) {
        set({ statusMessage: `放置角色失败：${result.batch.code}` })
        return
      }
      set({
        core: result.batch.state,
        history: result.history,
        selection: { type: 'actor', id: actorId },
        saveStatus: 'saving',
        statusMessage: '已放置角色',
      })
    },

    placeActorOnBoard: (actorId, boardId) => {
      const { core, currentBoardId } = get()
      const targetBoardId = boardId ?? currentBoardId
      const position = nextFreeActorPosition(core.runtime.placements, targetBoardId)
      get().placeActorAt(
        actorId,
        targetBoardId,
        position.x,
        position.y,
        { kind: 'board' },
        { precision: 'approximate', relativeDirection: 'nearby' }
      )
    },

    moveActorTo: (actorId, boardId, x, y, anchor, semantic) => {
      const { core, idGen, history } = get()
      const prev = core.runtime.placements.find((p) => p.actorId === actorId)
      const prevAnchorId =
        prev?.anchor.kind === 'node' ? (prev.anchor.nodeId ?? null) : null
      const nextAnchorId = anchor?.kind === 'node' ? (anchor.nodeId ?? null) : null
      const rowCommands = anchorRowCommands(core, prevAnchorId, nextAnchorId)
      const result = runBatch(
        core,
        history,
        {
          schemaVersion: 1,
          expectedRevision: core.runtime.revision,
          commands: [
            {
              type: 'move_actor',
              actorId,
              to: {
                boardId,
                anchor: anchor ?? { kind: 'board' },
                position: {
                  x: roundCanvas(x),
                  y: roundCanvas(y),
                },
                semanticPosition: {
                  precision: (semantic?.precision as never) ?? 'approximate',
                  ...(semantic?.relativeDirection
                    ? { relativeDirection: semantic.relativeDirection as never }
                    : {}),
                  ...(semantic?.note ? { note: semantic.note } : {}),
                },
              },
              reason: 'user_drag',
            },
            ...rowCommands,
          ],
        },
        { now: now(), source: 'user', idGen, label: 'move-actor' }
      )
      if (!result.batch.ok) {
        set({ statusMessage: `移动角色失败：${result.batch.code}` })
        return
      }
      set({
        core: result.batch.state,
        history: result.history,
        selection: { type: 'actor', id: actorId },
        saveStatus: 'saving',
        statusMessage: '已移动角色',
      })
    },

    removeActorFromBoard: (actorId) => {
      const { core, idGen, history } = get()
      const prev = core.runtime.placements.find((p) => p.actorId === actorId)
      const prevAnchorId =
        prev?.anchor.kind === 'node' ? (prev.anchor.nodeId ?? null) : null
      const rowCommands = anchorRowCommands(core, prevAnchorId, null)
      const result = runBatch(
        core,
        history,
        {
          schemaVersion: 1,
          expectedRevision: core.runtime.revision,
          commands: [
            { type: 'remove_actor_from_board', actorId },
            ...rowCommands,
          ],
        },
        { now: now(), source: 'user', idGen, label: 'remove-actor' }
      )
      if (!result.batch.ok) {
        set({ statusMessage: `移出角色失败：${result.batch.code}` })
        return
      }
      set({
        core: result.batch.state,
        history: result.history,
        selection: { type: 'none', id: null },
        saveStatus: 'saving',
        statusMessage: '已将角色移出画板',
      })
    },
  }
}