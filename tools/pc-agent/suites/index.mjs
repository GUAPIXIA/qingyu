// 测试旅程（suite）注册表。suite 在 CLI / MCP 进程内运行，通过 client 向宿主发起请求。
// 约定：run(ctx) 返回 { suite, passed, steps: [{name, pass, detail}], skipped: [...] }；
// 不直接操作 Playwright 句柄，也不内联业务逻辑——动作一律走 catalog 登记。
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { chatBasicSuite } from './chat-basic.mjs'
import { chatLifecycleSuite } from './chat-lifecycle.mjs'
import { characterLifecycleSuite } from './character-lifecycle.mjs'
import { settingsLifecycleSuite } from './settings-lifecycle.mjs'
import { groupLifecycleSuite } from './group-lifecycle.mjs'
import { lorebookLifecycleSuite } from './lorebook-lifecycle.mjs'
import { presetLifecycleSuite } from './preset-lifecycle.mjs'
import { usageLifecycleSuite } from './usage-lifecycle.mjs'
import { logLifecycleSuite } from './log-lifecycle.mjs'
import { systemLifecycleSuite } from './system-lifecycle.mjs'
import { regexLifecycleSuite } from './regex-lifecycle.mjs'
import { quickReplyLifecycleSuite } from './quickreply-lifecycle.mjs'
import { spatialLifecycleSuite } from './spatial-lifecycle.mjs'
import { embeddingLifecycleSuite } from './embedding-lifecycle.mjs'
import { envProbeSuite } from './env-probe.mjs'
import { llmLifecycleSuite } from './llm-lifecycle.mjs'
import { comfyuiLifecycleSuite } from './comfyui-lifecycle.mjs'
import { ttsLifecycleSuite } from './tts-lifecycle.mjs'
import { dialogFreeIoSuite } from './io-lifecycle.mjs'

const SUITES = new Map([
  [chatBasicSuite.id, chatBasicSuite],
  [chatLifecycleSuite.id, chatLifecycleSuite],
  [characterLifecycleSuite.id, characterLifecycleSuite],
  [settingsLifecycleSuite.id, settingsLifecycleSuite],
  [groupLifecycleSuite.id, groupLifecycleSuite],
  [lorebookLifecycleSuite.id, lorebookLifecycleSuite],
  [presetLifecycleSuite.id, presetLifecycleSuite],
  [usageLifecycleSuite.id, usageLifecycleSuite],
  [logLifecycleSuite.id, logLifecycleSuite],
  [systemLifecycleSuite.id, systemLifecycleSuite],
  [regexLifecycleSuite.id, regexLifecycleSuite],
  [quickReplyLifecycleSuite.id, quickReplyLifecycleSuite],
  [spatialLifecycleSuite.id, spatialLifecycleSuite],
  [embeddingLifecycleSuite.id, embeddingLifecycleSuite],
  [envProbeSuite.id, envProbeSuite],
  [llmLifecycleSuite.id, llmLifecycleSuite],
  [comfyuiLifecycleSuite.id, comfyuiLifecycleSuite],
  [ttsLifecycleSuite.id, ttsLifecycleSuite],
  [dialogFreeIoSuite.id, dialogFreeIoSuite],
])

export function loadSuite(id) {
  return SUITES.get(id) ?? null
}

export function listSuites() {
  return [...SUITES.keys()]
}

/**
 * 步骤记录器：统一 pass/fail/skip 语义。
 * skip 用于“需要模型/网络/原生对话框等环境”的项——如实记录原因，不算通过。
 */
export function createRecorder({ log = () => {} } = {}) {
  const steps = []
  const skipped = []

  const step = async (name, fn) => {
    try {
      const detail = await fn()
      steps.push({ name, pass: true, detail: detail ?? null })
      log(`✓ ${name}${detail ? ` — ${detail}` : ''}`)
      return { ok: true, value: detail }
    } catch (error) {
      steps.push({ name, pass: false, detail: String(error.message) })
      log(`✗ ${name} — ${error.message}`)
      return { ok: false, error }
    }
  }

  const skip = (name, reason) => {
    skipped.push({ name, reason })
    steps.push({ name, pass: true, skipped: true, detail: `跳过：${reason}` })
    log(`- ${name} — 跳过：${reason}`)
  }

  const expect = (condition, message) => {
    if (!condition) throw new Error(message)
  }

  return { steps, skipped, step, skip, expect }
}

/** 统一的动作调用包装：非 succeeded 即抛错，避免把失败当通过 */
export function createInvoker({ request, log = () => {} }) {
  return async function invoke(action, args = [], { purpose = 'invoke' } = {}) {
    const outcome = await request(purpose === 'observe' ? 'observe' : 'invoke', { action, args })
    if (outcome.status !== 'succeeded') {
      const error = new Error(`${action} → ${outcome.status}：${outcome.error?.message ?? '未返回结果'}`)
      error.code = outcome.error?.code ?? 'ACTION_FAILED'
      error.outcome = outcome
      throw error
    }
    return outcome.result
  }
}

/** 把 suite 结果落到 run 目录（按 suite 命名，避免同一会话内多条 suite 互相覆盖） */
export function writeSuiteArtifact(runDir, result) {
  const path = resolve(runDir, `suite-result-${result.suite}.json`)
  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  const reportPath = resolve(runDir, 'report.md')
  const lines = [
    `## suite ${result.suite}：${result.passed ? '通过' : '未通过'}`,
    '',
    `- 会话：\`${result.sessionId}\``,
    `- 时间：${result.startedAt} → ${result.finishedAt}`,
    '',
    '| 步骤 | 结果 | 说明 |',
    '|---|---|---|',
    ...result.steps.map((item) => `| ${item.name} | ${item.skipped ? '跳过' : item.pass ? '通过' : '未通过'} | ${String(item.detail ?? '-').replace(/\|/g, '\\|')} |`),
    '',
  ]
  if (result.skipped?.length) {
    lines.push('跳过项（需要环境，未验证）：', '')
    for (const item of result.skipped) lines.push(`- ${item.name}：${item.reason}`)
    lines.push('')
  }
  if (existsSync(reportPath)) appendFileSync(reportPath, `${lines.join('\n')}\n`, 'utf8')
  else writeFileSync(reportPath, `# suite ${result.suite}\n\n${lines.join('\n')}\n`, 'utf8')
  return path
}

/** suite 收尾公共逻辑：汇总 + 落盘 */
export async function finishSuite({ request, suiteId, sessionId, startedAt, recorder, targets, extra = {} }) {
  const finishedAt = new Date().toISOString()
  const result = {
    suite: suiteId,
    sessionId,
    startedAt,
    finishedAt,
    passed: recorder.steps.every((item) => item.pass),
    skipped: recorder.skipped,
    targets,
    steps: recorder.steps,
    ...extra,
  }
  const evidence = await request('evidence')
  result.runDir = evidence.runDir
  result.counts = { actions: evidence.actions.length, assertions: evidence.summary }
  writeSuiteArtifact(evidence.runDir, result)
  return result
}




