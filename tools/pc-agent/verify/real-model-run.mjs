#!/usr/bin/env node
// 真实模型 / 真实生图验证入口（需用户授权与本地环境）。
//
// 做四件事：
//  1. 起隔离会话；
//  2. 把目标连接档案（LLM）与生图模型写进**隔离档案**的设置并设为 active；
//  3. 用 verify/seed-credential.cjs 把密钥加密写入隔离档案的 credentials.json（工具本身不持有密钥）；
//  4. 依次跑 llm.lifecycle 与 comfyui.lifecycle，输出结构化结果。
//
// 用法：
//   node tools/pc-agent/verify/real-model-run.mjs \
//     --key-file <密钥文件> [--profile-name 小米] [--model mimo-v2.5-pro] \
//     [--llm-base-url https://api.xiaomimimo.com/v1] [--image-base-url http://127.0.0.1:8188]
//
// 安全：不打印密钥；密钥只写入隔离档案（run 目录内），运行结束不清理以便复核，且 run 目录已被 gitignore。
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AgentClient } from '../client.mjs'
import { loadSuite } from '../suites/index.mjs'
import { writeJson } from '../lib/evidence.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

function parseArgs(argv) {
  const out = {}
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (!item.startsWith('--')) continue
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) out[item.slice(2)] = true
    else { out[item.slice(2)] = next; index += 1 }
  }
  return out
}

/** 从正式档案读取指定名称的生图模型作为模板（只读非敏感字段；apiKey 不进入隔离档案） */
function productionSettingsPath() {
  return resolve(process.env.APPDATA ?? '', 'qingyu', 'data', 'config', 'settings.json')
}

function readImageTemplate(settingsPath, name) {
  if (!existsSync(settingsPath)) return null
  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    const found = (settings.imageGenModels ?? []).find((item) => item.name === name || item.workflowName === name)
    if (!found) return null
    const { apiKey, ...rest } = found
    void apiKey
    return rest
  } catch {
    return null
  }
}

async function main() {const args = parseArgs(process.argv.slice(2))
const keyFile = args['key-file'] ? resolve(args['key-file']) : null
const profileName = args['profile-name'] ?? '小米'
const llmModel = args['model'] ?? 'mimo-v2.5-pro'
const llmBaseUrl = args['llm-base-url'] ?? 'https://api.xiaomimimo.com/v1'
const imageBaseUrl = args['image-base-url'] ?? 'http://127.0.0.1:8188'
const imageModelName = args['image-model'] ?? 'image_z_image_turbo'

if (!keyFile || !existsSync(keyFile)) {
  console.error('缺少 --key-file（可用 scripts/decrypt-api-key.cjs 生成到 output/ 下）')
  process.exit(2)
}
const keyLength = readFileSync(keyFile, 'utf8').trim().length
console.log(`[真实模型验证] 密钥文件已就绪（len=${keyLength}，不打印内容）`)

const result = { startedAt: new Date().toISOString(), profileName, llmModel, llmBaseUrl, imageBaseUrl, suites: {}, errors: [] }
const WRITE_MODULES = ['character', 'chat', 'settings', 'ai', 'chatTask', 'imageGen']

const hostClient = await AgentClient.forHost()
let sessionId = null
let client = null
try {
  const started = await hostClient.request('session.start', {
    profile: 'source-isolated',
    allowedWriteModules: WRITE_MODULES,
    allowCredentialWrite: true,
    label: 'real-model',
  })
  sessionId = started.session.sessionId
  const runDir = started.runDir
  const userDataDir = started.session.userDataDir
  result.sessionId = sessionId
  result.runDir = runDir
  console.log(`[真实模型验证] 会话 ${sessionId}\n  run: ${runDir}`)

  // 会话级客户端：后续请求自动带上 sessionId
  client = await AgentClient.forSession(sessionId)
  hostClient.close()

  // 1) 写连接档案（LLM）与生图模型到隔离档案设置，并设为 active
  const settings = await client.request('observe', { action: 'settings.get', args: [] })
  const next = structuredClone(settings.result)
  const profileId = `qa-real-${Date.now().toString(36)}`
  next.connectionProfiles = [
    ...(next.connectionProfiles ?? []).filter((item) => item.id !== profileId),
    { id: profileId, name: profileName, provider: 'openai', baseUrl: llmBaseUrl, model: llmModel },
  ]
  next.activeProfileId = profileId
  next.activeModel = llmModel
  // 生图模型需要 workflow（否则报“未配置工作流”）：从正式档案复制一份**去掉 apiKey** 的模板，
  // 只保留 provider/baseUrl/workflow 等非敏感字段，再换成本次隔离档案的 id。
  const imageId = `qa-img-${Date.now().toString(36)}`
  const template = readImageTemplate(productionSettingsPath(), imageModelName)
  const imageEntry = template
    ? { ...template, id: imageId, name: imageModelName, baseUrl: imageBaseUrl, enabled: true, apiKey: undefined }
    : { id: imageId, name: imageModelName, provider: 'comfyui', baseUrl: imageBaseUrl, enabled: true }
  next.imageGenModels = [...(next.imageGenModels ?? []).filter((item) => item.id !== imageId), imageEntry]
  next.activeImageGenModelId = imageId
  result.imageTemplate = template ? template.workflowName ?? template.name : null
  const saved = await client.request('invoke', { action: 'settings.save', args: [next] })
  if (saved.status !== 'succeeded') throw new Error(`settings.save → ${saved.status}：${saved.error?.message ?? ''}`)
  console.log(`[真实模型验证] 已写入隔离设置：LLM=${profileName}/${llmModel}，生图=${imageModelName}@${imageBaseUrl}`)

  // 2) 用产品自己的凭据写入 IPC 写入密钥（受控动作，需 --allow-credential-write）
  const credentialKey = readFileSync(keyFile, 'utf8').trim()
  const saved2 = await client.request('invoke', { action: 'settings.saveAPICredential', args: [`profile-${profileId}`, credentialKey] })
  if (saved2.status !== 'succeeded') throw new Error(`凭据写入 → ${saved2.status}：${saved2.error?.message ?? ''}`)
  result.credentialSeeded = true
  console.log('[真实模型验证] 凭据已写入隔离档案（经产品 IPC，密钥不出现在日志中）')

  // 注入凭据后重启应用：让主进程从磁盘重新读取设置与凭据（避免使用启动时的旧快照）
  const restarted = await client.request('session.restart')
  console.log(`[真实模型验证] 已重启应用以加载新设置与凭据（state=${restarted.session.state}）`)

  // 3) 跑旅程
  for (const suiteId of ['llm.lifecycle', 'comfyui.lifecycle']) {
    const suite = loadSuite(suiteId)
    console.log(`\n--- ${suiteId} ---`)
    const outcome = await suite.run({
      request: (method, params) => client.request(method, params),
      sessionId,
      log: (message) => console.log(`  ${message}`),
    })
    result.suites[suiteId] = {
      passed: outcome.passed,
      steps: outcome.steps.length,
      skipped: outcome.skipped.length,
      failedSteps: outcome.steps.filter((item) => !item.pass).map((item) => `${item.name} — ${item.detail}`),
      runDir: outcome.runDir,
    }
    console.log(`  → ${outcome.passed ? '通过' : '未通过'}（${outcome.steps.length} 步）`)
  }
} catch (error) {
  result.errors.push(String(error?.stack ?? error))
  console.error('[真实模型验证] 失败：', error.message)
} finally {
  if (sessionId && client) {
    const closed = await client.request('session.close', { sessionId }).catch(() => null)
    result.summary = closed?.summary ?? null
  }
  client?.close()
  hostClient.close()
}

result.finishedAt = new Date().toISOString()
result.passed = result.errors.length === 0 && Object.values(result.suites).every((item) => item.passed)
if (result.runDir) writeJson(resolve(result.runDir, 'real-model-result.json'), result)
console.log(`\n[真实模型验证] ${result.passed ? '通过' : '未通过'}${result.runDir ? `：${result.runDir}` : ''}`)
process.exit(result.passed ? 0 : 1)
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isDirectRun) await main()

export { main as runRealModel }



