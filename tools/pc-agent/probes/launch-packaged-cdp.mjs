#!/usr/bin/env node
// 阶段 0 探针 B：打包/安装版 + CDP 连接可行性（对应方案退出条件 ④）
//
// 用本仓库已构建的打包产物 release-v2/win-unpacked/轻语.exe（不是用户安装的实例，也不接管用户已打开的客户端），
// 以 --user-data-dir 隔离 + --remote-debugging-port 暴露调试端点，再用 Playwright connectOverCDP 连接。
//
// 验证：打包产物是否加载发布 bundle（file://…/dist/index.html）、window.api 是否可用、
//       隔离是否只落在 run 目录（正式数据目录不被触碰）、CDP 是否可用于后续 attach/installed 模式。
// 安全闸门：若隔离目录在启动后仍为空，判定隔离未生效，立即结束并报告，不继续操作。
//
// 用法：node tools/pc-agent/probes/launch-packaged-cdp.mjs
import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadContract } from '../lib/ipc-contract.mjs'
import {
  PACKAGED_EXE,
  PROD_USER_DATA,
  REPO_ROOT,
  createRunDir,
  dirSignature,
  electronEnv,
  findFreePort,
  killTree,
  loadPlaywright,
  nowIso,
  sameSignature,
  waitForHttp,
  writeJson,
  writeText,
} from './lib/probe-common.mjs'

const runDir = createRunDir('packaged-cdp')
const userDataDir = resolve(runDir, 'user-data')
const port = findFreePort(9333)

const result = {
  probe: 'launch-packaged-cdp',
  mode: 'packaged-isolated / installed',
  startedAt: nowIso(),
  runDir,
  userDataDir,
  executable: PACKAGED_EXE,
  debugPort: port,
  checks: [],
  productionUserData: [],
  errors: [],
}

function check(name, passed, detail) {
  result.checks.push({ name, passed: Boolean(passed), detail })
  console.log(` ${passed ? '✓' : '✗'} ${name}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
  return Boolean(passed)
}

const prodBefore = PROD_USER_DATA.map((dir) => dirSignature(dir))
result.productionUserData = prodBefore.map((before) => ({ before }))

let child
let browser
try {
  console.log(`[probe B] run 目录：${runDir}`)
  check('打包产物存在', existsSync(PACKAGED_EXE), PACKAGED_EXE)
  if (!existsSync(PACKAGED_EXE)) throw new Error('打包产物不存在，需先 pnpm electron:build')

  // 打包产物身份：用于说明“打包版运行的不是当前源码契约”
  const exeStat = statSync(PACKAGED_EXE)
  const asarPath = resolve(REPO_ROOT, 'release-v2', 'win-unpacked', 'resources', 'app.asar')
  result.buildIdentity = {
    executable: PACKAGED_EXE,
    executableSize: exeStat.size,
    executableMtime: exeStat.mtime.toISOString(),
    asar: existsSync(asarPath) ? { size: statSync(asarPath).size, mtime: statSync(asarPath).mtime.toISOString() } : null,
    sourceContractNamespaces: loadContract().namespaces.length,
  }

  const { env, sanitized } = electronEnv()
  result.env = sanitized
  check('启动前清除 ELECTRON_RUN_AS_NODE', true, `宿主环境原值 ${sanitized.ELECTRON_RUN_AS_NODE ?? '未设置'}`)

  child = spawn(PACKAGED_EXE, [`--user-data-dir=${userDataDir}`, `--remote-debugging-port=${port}`], {
    cwd: resolve(REPO_ROOT, 'release-v2', 'win-unpacked'),
    env,
    stdio: 'ignore',
    detached: false,
  })
  result.pid = child.pid

  const version = await waitForHttp(`http://127.0.0.1:${port}/json/version`, { attempts: 90, intervalMs: 500 })
  result.cdp = { browser: version.Browser, protocolVersion: version['Protocol-Version'], userAgent: version['User-Agent'] }
  check('CDP 调试端点可用', Boolean(version.Browser), version.Browser)

  // 安全闸门：先确认隔离生效，再继续读取页面
  const isolatedNow = dirSignature(userDataDir)
  const isolatedEffective = (isolatedNow.files ?? 0) > 0
  check('安全闸门：隔离 userData 已生效（被应用写入）', isolatedEffective, `${isolatedNow.files} 个文件`)
  if (!isolatedEffective) throw new Error('隔离未生效：隔离目录为空，终止探针以避免触碰正式数据')

  const playwright = loadPlaywright()
  browser = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${port}`)
  const context = browser.contexts()[0]
  check('connectOverCDP 建立连接', Boolean(context), context ? '已连接' : '无 browser context')

  const deadline = Date.now() + 60000
  let pages = []
  let target = null
  while (Date.now() < deadline) {
    pages = []
    for (const page of context.pages()) {
      let apiType = 'n/a'
      try {
        apiType = await page.evaluate(() => typeof window.api)
      } catch (error) {
        apiType = `error: ${String(error.message).split('\n')[0]}`
      }
      pages.push({ url: page.url(), title: await page.title().catch(() => ''), apiType })
    }
    target = context.pages().find((page, index) => pages[index]?.apiType === 'object' && !pages[index].url.startsWith('devtools://'))
    if (target) break
    await new Promise((done) => setTimeout(done, 1000))
  }
  result.pages = pages
  for (const item of pages) console.log(`    页面：${item.url.slice(0, 110)} | api=${item.apiType} | ${item.title}`)

  const mainPage = pages.find((item) => item.apiType === 'object' && !item.url.startsWith('devtools://'))
  check('找到真实主窗口（window.api 可用）', Boolean(mainPage), mainPage?.url ?? '未找到')
  check('渲染层为发布产物（file://…/dist/index.html）', Boolean(mainPage?.url?.startsWith('file://') && mainPage.url.includes('dist/index.html')), mainPage?.url ?? '-')
  check('打包运行下未打开 detached DevTools', !pages.some((item) => item.url.startsWith('devtools://')), `devtools=${pages.filter((item) => item.url.startsWith('devtools://')).length}`)

  if (target) {
    result.apiShape = await target.evaluate(() => {
      const api = window.api
      const namespaces = Object.keys(api ?? {})
      return { namespaces: namespaces.length, names: namespaces.sort(), getVersion: typeof api?.app?.getVersion, renameSession: typeof api?.chat?.renameSession }
    })
    check('window.api 可驱动（命名空间 ≥ 25）', result.apiShape.namespaces >= 25, String(result.apiShape.namespaces))

    // 构建陈旧检测：打包产物暴露的接口面 vs 当前源码契约
    const contract = loadContract()
    const contractNames = contract.namespaces.map((ns) => ns.namespace)
    const missing = contractNames.filter((name) => !result.apiShape.names.includes(name))
    const extra = result.apiShape.names.filter((name) => !contractNames.includes(name))
    result.contractDrift = {
      sourceContract: contractNames.length,
      packagedApi: result.apiShape.namespaces,
      missingInPackaged: missing,
      extraInPackaged: extra,
      sourceContractHash: contract.contractHash,
    }
    check('检测到打包产物与当前源码契约的差异（验证“构建陈旧必须显式报告”）', missing.length > 0 || extra.length > 0,
      `缺失 ${missing.join(',') || '无'} · 多出 ${extra.join(',') || '无'}`)
    if (missing.length > 0) console.log(`       → 打包产物缺少当前契约中的命名空间：${missing.join(', ')}`)

    result.invocations = await target.evaluate(async () => {
      const api = window.api
      const outcome = {}
      for (const [name, call] of Object.entries({
        appVersion: () => api.app.getVersion(),
        characters: () => api.character.list(),
        presets: () => api.preset.list(),
      })) {
        try {
          const value = await call()
          outcome[name] = Array.isArray(value) ? { ok: true, kind: `array(${value.length})` } : { ok: true, kind: typeof value, value: String(value).slice(0, 40) }
        } catch (error) {
          outcome[name] = { ok: false, error: String(error.message).slice(0, 140) }
        }
      }
      return outcome
    })
    check('打包版只读调用返回真实结果', Object.values(result.invocations).every((item) => item.ok), JSON.stringify(result.invocations))
    await target.screenshot({ path: resolve(runDir, 'screenshots', 'packaged-main-window.png'), timeout: 20000 }).catch(() => {})
    result.screenshot = 'screenshots/packaged-main-window.png'
  }

  result.isolatedUserData = dirSignature(userDataDir)
} catch (error) {
  result.errors.push(String(error?.stack ?? error))
  console.error('[probe B] 失败：', error)
} finally {
  if (browser) await browser.close().catch(() => {})
  if (child?.pid) {
    killTree(child.pid)
    await new Promise((done) => setTimeout(done, 1500))
  }
  for (const dir of PROD_USER_DATA) {
    const before = prodBefore[PROD_USER_DATA.indexOf(dir)]
    const after = dirSignature(dir)
    const entry = result.productionUserData.find((item) => item.before.path === dir)
    entry.after = after
    entry.unchanged = sameSignature(before, after)
    check(`正式数据目录未被触碰：${dir}`, entry.unchanged, entry.unchanged ? 'mtime/条目数/文件数一致' : `${before.mtime} → ${after.mtime}`)
  }
}

result.finishedAt = nowIso()
result.passed = result.checks.every((item) => item.passed) && result.errors.length === 0
writeJson(resolve(runDir, 'result.json'), result)

const lines = []
lines.push('# 阶段 0 探针 B：打包/安装版 + CDP 连接')
lines.push('')
lines.push(`- 结果：${result.passed ? '✅ 通过' : '❌ 未通过'}`)
lines.push(`- run 目录：\`${runDir}\``)
lines.push(`- 目标可执行文件：\`${result.executable}\`（本仓库打包产物，非用户安装实例）`)
lines.push(`- 启动参数：\`--user-data-dir=${result.userDataDir} --remote-debugging-port=${result.debugPort}\``)
lines.push(`- CDP：${result.cdp?.browser ?? '-'} / protocol ${result.cdp?.protocolVersion ?? '-'}`)
if (result.buildIdentity) {
  lines.push(`- 打包产物：${result.buildIdentity.executableSize} 字节，构建于 ${result.buildIdentity.executableMtime}`)
  lines.push(`- app.asar：${result.buildIdentity.asar ? `${result.buildIdentity.asar.size} 字节，${result.buildIdentity.asar.mtime}` : '未找到'}`)
}
lines.push('')
if (result.contractDrift) {
  lines.push('## 构建陈旧检测')
  lines.push('')
  lines.push(`- 当前源码契约命名空间：${result.contractDrift.sourceContract}（哈希 \`${result.contractDrift.sourceContractHash}\`）`)
  lines.push(`- 打包产物 window.api 命名空间：${result.contractDrift.packagedApi}`)
  lines.push(`- 打包产物缺少：${result.contractDrift.missingInPackaged.join(', ') || '无'}`)
  lines.push(`- 打包产物多出：${result.contractDrift.extraInPackaged.join(', ') || '无'}`)
  lines.push('')
  lines.push('> 结论：`installed` / 打包模式必须记录构建身份，并在驱动前比对契约；否则会把旧版本的行为当成当前版本结果。')
  lines.push('')
}
lines.push('| 检查项 | 结果 | 说明 |')
lines.push('|---|---|---|')
for (const item of result.checks) {
  lines.push(`| ${item.name} | ${item.passed ? '通过' : '未通过'} | ${item.detail === undefined ? '-' : String(JSON.stringify(item.detail)).replace(/\|/g, '\\|')} |`)
}
if (result.pages?.length) {
  lines.push('')
  lines.push('## 探测到的页面')
  lines.push('')
  lines.push('| URL | window.api | 标题 |')
  lines.push('|---|---|---|')
  for (const item of result.pages) lines.push(`| \`${item.url.slice(0, 120)}\` | ${item.apiType} | ${item.title} |`)
}
if (result.invocations) {
  lines.push('')
  lines.push('## 只读调用')
  lines.push('')
  lines.push('| 调用 | 结果 |')
  lines.push('|---|---|')
  for (const [name, value] of Object.entries(result.invocations)) {
    lines.push(`| ${name} | ${value.ok ? `ok · ${value.kind}${value.value === undefined ? '' : ` · ${value.value}`}` : `失败 · ${value.error}`} |`)
  }
}
if (result.errors.length) {
  lines.push('')
  lines.push('## 错误')
  for (const error of result.errors) lines.push('```\n' + error + '\n```')
}
writeText(resolve(runDir, 'report.md'), `${lines.join('\n')}\n`)

console.log('')
console.log(`[probe B] ${result.passed ? '通过' : '未通过'}：${runDir}`)
process.exit(result.passed ? 0 : 1)
