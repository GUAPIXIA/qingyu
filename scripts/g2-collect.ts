/**
 * G2 主对话观测采集（真实 API 调用 → generation-observations.jsonl）。
 *
 * 不同 evaluate-generation：本脚本按生产口径写观测（source=single、无 taskType），
 * 供 g2-progress 统计 500 次有效生成。评测器产物不计入 G2。
 *
 * 用法（密钥只经 --key-file，不进 argv/env 明文）：
 *   npx tsx scripts/g2-collect.ts \
 *     --arm name=chenxi,provider=openai,model=deepseek-v4.1-flash,baseUrl=http://...,keyFile=...,weight=400 \
 *     --arm name=relayapi,provider=openai,model=gemini-3.8-flash,baseUrl=https://...,keyFile=...,weight=100 \
 *     --out-jsonl <默认 userData 观测文件> \
 *     --concurrency 2 --progress .poc-tmp/g2-collect-progress.json
 *
 * 分段：不写 gateLevel（→ none），与既有本机样本同段，便于凑满单段 500。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir, platform } from 'node:os'
import { openaiAdapter } from '../electron/services/adapters/openai'
import { buildGenerationObservation } from '../shared/generationObservation'
import type { ChatParams } from '../shared/types'
import type { GenerationObservation } from '../shared/generationObservation'

interface Arm {
  name: string
  provider: string
  model: string
  baseUrl: string
  keyFile: string
  weight: number
}

interface CollectProgress {
  updatedAt: number
  totalTarget: number
  written: number
  byArm: Record<string, { attempted: number; ok: number; error: number }>
  lastRequestId?: string
}

function parseArgs(): {
  arms: Arm[]
  outJsonl?: string
  concurrency: number
  progressFile: string
  maxRetries: number
} {
  const args = process.argv.slice(2)
  const arms: Arm[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--arm' && args[i + 1]) {
      const spec = args[++i]
      const map = new Map<string, string>()
      for (const part of spec.split(',')) {
        const eq = part.indexOf('=')
        if (eq > 0) map.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim())
      }
      const name = map.get('name')
      const model = map.get('model')
      const baseUrl = map.get('baseUrl')
      const keyFile = map.get('keyFile')
      if (!name || !model || !baseUrl || !keyFile) {
        throw new Error(`--arm 缺少 name/model/baseUrl/keyFile：${spec}`)
      }
      arms.push({
        name,
        provider: map.get('provider') || 'openai',
        model,
        baseUrl,
        keyFile,
        weight: Number(map.get('weight') || '1'),
      })
    }
  }
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag)
    return i >= 0 ? args[i + 1] : undefined
  }
  if (arms.length === 0) throw new Error('至少需要一个 --arm')
  return {
    arms,
    outJsonl: get('--out-jsonl'),
    concurrency: Number(get('--concurrency') || '2'),
    progressFile: get('--progress') || join('.poc-tmp', 'g2-collect-progress.json'),
    maxRetries: Number(get('--max-retries') || '1'),
  }
}

function defaultObservationsPath(): string {
  const base = platform() === 'win32'
    ? process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
    : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'))
  const candidates = [
    join(base, 'qingyu', 'data', 'diagnostics', 'generation-observations.jsonl'),
    join(base, '轻语', 'data', 'diagnostics', 'generation-observations.jsonl'),
  ]
  return candidates.find((c) => existsSync(c)) ?? candidates[0]
}

function expandPlan(arms: Arm[]): Arm[] {
  const queues = arms.map((arm) => ({
    arm,
    left: Math.max(1, Math.floor(arm.weight)),
  }))
  const plan: Arm[] = []
  const total = queues.reduce((s, q) => s + q.left, 0)
  while (plan.length < total) {
    for (const q of queues) {
      if (q.left <= 0) continue
      plan.push(q.arm)
      q.left -= 1
    }
  }
  return plan
}

function loadProgress(file: string): CollectProgress {
  if (existsSync(file)) {
    try {
      return JSON.parse(readFileSync(file, 'utf-8')) as CollectProgress
    } catch { /* ignore */ }
  }
  return {
    updatedAt: Date.now(),
    totalTarget: 0,
    written: 0,
    byArm: {},
  }
}

function saveProgress(file: string, progress: CollectProgress): void {
  mkdirSync(dirname(file), { recursive: true })
  progress.updatedAt = Date.now()
  writeFileSync(file, JSON.stringify(progress, null, 2), 'utf-8')
}

function countValidInFile(jsonlPath: string): number {
  if (!existsSync(jsonlPath)) return 0
  let n = 0
  for (const line of readFileSync(jsonlPath, 'utf-8').split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const r = JSON.parse(t) as GenerationObservation
      if (
        (r.source === 'single' || r.source === 'group' || r.source === 'bridge')
        && !r.taskType
        && (r.outcome === 'completed' || r.outcome === 'truncated' || r.outcome === 'user_cancelled')
      ) n++
    } catch { /* skip */ }
  }
  return n
}

const SYSTEM_PROMPT =
  '你是沉浸式互动叙事引擎，扮演 {{char}} 与 {{user}} 持续互动。保持角色设定与已有情节一致，用具体动作与对白推进场景，不替 {{user}} 决定行动或言语。用中文回复 2-4 个自然段落。'
const USER_PROMPT = '你：我推开门，废土上的风卷着沙子打在脸上。外面安静得可怕。\n艾琳：嘘——别出声。你看那边。'

async function collectOne(arm: Arm, outJsonl: string, maxRetries: number): Promise<'ok' | 'error'> {
  const apiKey = readFileSync(arm.keyFile, 'utf-8').trim()
  const requestId = `g2-${arm.name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const params: ChatParams = {
    requestId,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: USER_PROMPT },
    ],
    provider: arm.provider as ChatParams['provider'],
    apiKey,
    baseUrl: arm.baseUrl,
    model: arm.model,
    temperature: 0.8,
    topP: 0.95,
    maxTokens: 1024,
    frequencyPenalty: 0,
    presencePenalty: 0,
    stream: false,
    observability: {
      source: 'single',
      generationType: 'normal',
      characterId: 'g2-collect',
      sessionId: 'g2-collect-session',
    },
  }

  let lastError: unknown
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const startedAt = Date.now()
    try {
      const completion = await openaiAdapter.chat(params, () => {}, new AbortController().signal)
      const finishedAt = Date.now()
      const obs = buildGenerationObservation(params, {
        startedAt,
        finishedAt,
        text: completion.text,
        outcome: completion.finishReason === 'length' ? 'truncated' : 'completed',
        finishReason: completion.finishReason,
        ...(completion.usage?.completionTokens !== undefined
          ? { completionTokens: completion.usage.completionTokens }
          : {}),
        ...(completion.usage?.reasoningTokens !== undefined
          ? { reasoningTokens: completion.usage.reasoningTokens }
          : {}),
        attempts: attempt + 1,
        ...(completion.earlyAbort ? { earlyAbort: true } : {}),
      })
      mkdirSync(dirname(outJsonl), { recursive: true })
      appendFileSync(outJsonl, JSON.stringify(obs) + '\n', 'utf-8')
      return 'ok'
    } catch (err) {
      lastError = err
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
      }
    }
  }
  // 失败也写一条 error 观测（不计入 G2 分母），便于排查限流
  const finishedAt = Date.now()
  const obs = buildGenerationObservation(params, {
    startedAt: finishedAt - 1,
    finishedAt,
    text: '',
    outcome: 'error',
    finishReason: 'unknown',
    errorKind: /429|rate|timeout/i.test(String(lastError)) ? 'timeout' : 'api',
    attempts: maxRetries + 1,
  })
  mkdirSync(dirname(outJsonl), { recursive: true })
  appendFileSync(outJsonl, JSON.stringify(obs) + '\n', 'utf-8')
  return 'error'
}

async function main(): Promise<void> {
  const opts = parseArgs()
  const outJsonl = opts.outJsonl ?? defaultObservationsPath()
  const plan = expandPlan(opts.arms)
  const progress = loadProgress(opts.progressFile)
  progress.totalTarget = plan.length
  for (const arm of opts.arms) {
    if (!progress.byArm[arm.name]) {
      progress.byArm[arm.name] = { attempted: 0, ok: 0, error: 0 }
    }
    if (!existsSync(arm.keyFile)) {
      throw new Error(`密钥文件不存在：${arm.keyFile}`)
    }
  }

  console.log(`[g2-collect] out=${outJsonl}`)
  console.log(`[g2-collect] plan=${plan.length} concurrency=${opts.concurrency}`)
  for (const arm of opts.arms) {
    console.log(`[g2-collect] arm ${arm.name}: weight=${arm.weight} model=${arm.model}`)
  }

  let cursor = 0
  let ok = 0
  let error = 0
  const workerCount = Math.max(1, Math.min(opts.concurrency, plan.length))

  async function worker(workerId: number): Promise<void> {
    while (true) {
      const index = cursor++
      if (index >= plan.length) return
      const arm = plan[index]
      const result = await collectOne(arm, outJsonl, opts.maxRetries)
      progress.byArm[arm.name].attempted += 1
      if (result === 'ok') {
        progress.byArm[arm.name].ok += 1
        ok += 1
      } else {
        progress.byArm[arm.name].error += 1
        error += 1
      }
      progress.written = ok
      progress.lastRequestId = undefined
      saveProgress(opts.progressFile, progress)
      const validNow = countValidInFile(outJsonl)
      if ((index + 1) % 10 === 0 || index === plan.length - 1) {
        console.log(
          `[g2-collect] w${workerId} ${index + 1}/${plan.length} ok=${ok} err=${error} fileValid≈${validNow}`,
        )
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, (_, i) => worker(i + 1)))
  console.log(
    `[g2-collect] done ok=${ok} err=${error} arms=${JSON.stringify(progress.byArm)}`,
  )
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
