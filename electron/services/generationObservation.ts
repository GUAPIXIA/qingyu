/**
 * 生成观测持久化（阶段0「基线与观测」）。
 *
 * 分类与记录形状在 shared/generationObservation.ts（纯逻辑，供基线脚本复用）；
 * 本模块只负责 JSONL 追加落盘与简单轮转，写入失败静默（观测不阻塞生成）。
 *
 * 文件：`<userData>/data/diagnostics/generation-observations.jsonl`
 * 每行一条 GenerationObservation；超过 5MB 轮转为 `.old`（最多保留一代）。
 */

import { join } from 'node:path'
import { appendFileSync, existsSync, renameSync, statSync, mkdirSync } from 'node:fs'
import { app } from 'electron'
import type { GenerationObservation } from '../../shared/generationObservation'
import { createLogger } from './logger'

const log = createLogger('observation')

const ROTATE_THRESHOLD_BYTES = 5 * 1024 * 1024

/** 观测文件路径（diagnostics 目录在首次写入时确保存在） */
export function resolveObservationsFilePath(): string {
  return join(app.getPath('userData'), 'data', 'diagnostics', 'generation-observations.jsonl')
}

/** 追加一条观测记录（同步追加 + 轮转；调用方保证低频，单条失败静默） */
export function appendObservationToFile(filePath: string, obs: GenerationObservation): void {
  try {
    mkdirSync(join(filePath, '..'), { recursive: true })
    if (existsSync(filePath)) {
      const size = statSync(filePath).size
      if (size >= ROTATE_THRESHOLD_BYTES) {
        try {
          renameSync(filePath, `${filePath}.old`)
        } catch { /* 旧文件被占用等场景放弃轮转，继续追加 */ }
      }
    }
    appendFileSync(filePath, JSON.stringify(obs) + '\n', 'utf-8')
  } catch (e) {
    log.warn('观测记录写入失败', { error: e instanceof Error ? e.message : String(e) })
  }
}

/** 供上层调用的记录入口：观测绝不影响生成主流程 */
export function recordGenerationObservation(obs: GenerationObservation): void {
  try {
    appendObservationToFile(resolveObservationsFilePath(), obs)
  } catch { /* 双重兜底：观测失败不影响主流程 */ }
}
