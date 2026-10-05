#!/usr/bin/env node
// 阶段 0 探针 A：源码模式外部驱动可行性（两种隔离方式对照）
//
// A1 launcher-setPath ：run 目录内生成 launcher.cjs，先 app.setPath('userData', …) 再 require 现有主 bundle
//                       （沿用既有临时驱动的做法）
// A2 user-data-dir    ：直接以仓库为 app 路径启动，用 Electron 原生 --user-data-dir 开关隔离
//                       （不需要注入 launcher 文件）
//
// 共同验证：能否驱动现有应用、能否识别真实主窗口（并排除 detached DevTools）、window.api 是否可用、
//           只读调用是否返回真实结果、隔离是否生效、正式数据目录是否未被触碰。
//
// 用法：node tools/pc-agent/probes/launch-source-dev.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { startViteServer, waitForServer } from '../../../scripts/lib/browserHarness.mjs'
import {
  ELECTRON_EXE,
  PROD_USER_DATA,
  REPO_ROOT,
  createRunDir,
  dirSignature,
  electronEnv,
  loadPlaywright,
  nowIso,
  sameSignature,
  writeJson,
  writeText,
} from './lib/probe-common.mjs'

const VITE_PORT = 5173
const runDir = createRunDir('source-dev')

const result = {
  probe: 'launch-source-dev',
  mode: 'source-dev',
  startedAt: nowIso(),
  runDir,
  vitePort: VITE_PORT,
  env: null,
  variants: [],
  checks: [],
  productionUserData: [],
  errors: [],
}

function check(name, passed, detail) {
  result.checks.push({ name, passed: Boolean(passed), detail })
  console.log(` ${passed ? '✓' : '✗'} ${name}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
  return Boolean(passed)
}

const READ_ONLY_CALLS = `
  const readOnly = {
    appVersion: () => api.app.getVersion(),
    characters: () => api.character.list(),
    lorebooks: () => api.lorebook.list(),
    presets: () => api.preset.list(),
    personas: () => api.persona.list(),
    regexes: () => api.regex.list(),
    quickReplies: () => api.quickReply.listAll(),
    fonts: () => api.font.listFonts(),
  }
`

/** 启动一个隔离实例并采集证据 */
async function runVariant(playwright, { label, args, userDataDir, notes }) {
  const variant = { label, launchArgs: args, userDataDir, notes, checks: [], windows: [] }
  const record = (name, passed, detail) => {
    variant.checks.push({ name, passed: Boolean(passed), detail })
    console.log(`   ${passed ? '✓' : '✗'} [${label}] ${name}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
  }

  mkdirSync(userDataDir, { recursive: true })
  const { env, sanitized } = electronEnv()
  variant.envSanitized = sanitized

  let app
  try {
    app = await playwright.electron.launch({
      executablePath: ELECTRON_EXE,
      args,
      cwd: REPO_ROOT,
      env,
      timeout: 60000,
    })

    variant.mainProcess = await app.evaluate(({ app: electronApp }) => ({
      isPackaged: electronApp.isPackaged,
      name: electronApp.getName(),
      version: electronApp.getVersion(),
      userData: electronApp.getPath('userData'),
      appPath: electronApp.getAppPath(),
      electron: process.versions.electron,
    }))
    record('主进程 userData 指向本次隔离目录', resolve(variant.mainProcess.userData) === resolve(userDataDir), variant.mainProcess.userData)
    record('app.isPackaged 为 false（源码启动 → 渲染层走 dev server）', variant.mainProcess.isPackaged === false, String(variant.mainProcess.isPackaged))

    // 逐窗口探测 window.api，用于验证“识别真实主窗口、排除 DevTools”
    const deadline = Date.now() + 60000
    while (Date.now() < deadline) {
      variant.windows = []
      for (const page of app.windows()) {
        let apiType = 'n/a'
        try {
          apiType = await page.evaluate(() => typeof window.api)
        } catch (error) {
          apiType = `error: ${String(error.message).split('\n')[0]}`
        }
        variant.windows.push({ url: page.url(), title: await page.title().catch(() => ''), apiType })
      }
      if (variant.windows.some((item) => item.url.includes(`:${VITE_PORT}`) && item.apiType === 'object')) break
      await new Promise((done) => setTimeout(done, 1000))
    }
    for (const item of variant.windows) console.log(`       窗口：${item.url.slice(0, 90)} | api=${item.apiType} | ${item.title}`)

    const mainWindow = variant.windows.find((item) => item.url.includes(`:${VITE_PORT}`) && item.apiType === 'object')
    const devtools = variant.windows.filter((item) => item.url.startsWith('devtools://'))
    record('识别到真实主窗口（dev URL 且 window.api 可用）', Boolean(mainWindow), mainWindow?.url ?? '未找到')
    record('DevTools 窗口可识别并排除', devtools.length >= 1, `devtools=${devtools.length}`)

    const page = app.windows().find((item) => item.url().includes(`:${VITE_PORT}`))
    if (!page) throw new Error('未找到主窗口页面')

    variant.apiShape = await page.evaluate(() => {
      const api = window.api
      const namespaces = Object.keys(api ?? {})
      return {
        namespaces: namespaces.length,
        names: namespaces.sort(),
        renameSession: typeof api?.chat?.renameSession,
        listSessions: typeof api?.chat?.listSessions,
        getVersion: typeof api?.app?.getVersion,
      }
    })
    record('window.api 暴露 28 个命名空间', variant.apiShape.namespaces === 28, String(variant.apiShape.namespaces))
    record('代表方法存在（chat.renameSession / chat.listSessions / app.getVersion）',
      variant.apiShape.renameSession === 'function' && variant.apiShape.listSessions === 'function' && variant.apiShape.getVersion === 'function')

    variant.invocations = await page.evaluate(async () => {
      const api = window.api
      const started = performance.now()
      const readOnlyNames = ['appVersion', 'characters', 'lorebooks', 'presets', 'personas', 'regexes', 'quickReplies', 'fonts']
      const readOnly = {
        appVersion: () => api.app.getVersion(),
        characters: () => api.character.list(),
        lorebooks: () => api.lorebook.list(),
        presets: () => api.preset.list(),
        personas: () => api.persona.list(),
        regexes: () => api.regex.list(),
        quickReplies: () => api.quickReply.listAll(),
        fonts: () => api.font.listFonts(),
      }
      const results = {}
      for (const name of readOnlyNames) {
        try {
          const value = await readOnly[name]()
          results[name] = Array.isArray(value)
            ? { ok: true, kind: `array(${value.length})` }
            : { ok: true, kind: typeof value, value: value === null || typeof value !== 'object' ? value : '[object]' }
        } catch (error) {
          results[name] = { ok: false, error: String(error.message).slice(0, 160) }
        }
      }
      let missingArgError = null
      try {
        await api.chat.listSessions()
      } catch (error) {
        missingArgError = String(error.message).slice(0, 160)
      }
      return { results, missingArgError, elapsedMs: Math.round(performance.now() - started) }
    })

    const okReads = Object.entries(variant.invocations.results).filter(([, value]) => value.ok)
    const failedReads = Object.entries(variant.invocations.results).filter(([, value]) => !value.ok)
    record('无参只读调用可用（≥6/8）', okReads.length >= 6, okReads.map(([name, value]) => `${name}:${value.kind}`).join(' '))
    record('空隔离档案下角色/世界书/人设为空数组', ['characters', 'lorebooks', 'personas'].every((name) => variant.invocations.results[name]?.kind === 'array(0)'),
      ['characters', 'lorebooks', 'personas'].map((name) => `${name}=${variant.invocations.results[name]?.kind}`).join(' '))
    record('内置预设随产品提供（新档案即为非空数组）', variant.invocations.results.presets?.kind?.startsWith('array('), `presets=${variant.invocations.results.presets?.kind}`)
    record('缺参数调用被原接口拒绝（目录必须带参数 schema）', Boolean(variant.invocations.missingArgError), variant.invocations.missingArgError ?? '未报错')
    if (failedReads.length) console.log(`       只读未通过：${failedReads.map(([name, value]) => `${name} → ${value.error}`).join(' | ')}`)

    await page.screenshot({ path: resolve(runDir, 'screenshots', `${label}-main-window.png`), timeout: 20000 }).catch(() => {})
    variant.screenshot = `screenshots/${label}-main-window.png`

    variant.isolatedUserData = dirSignature(userDataDir)
    record('隔离 userData 已被应用写入', (variant.isolatedUserData.files ?? 0) > 0, `${variant.isolatedUserData.files} 个文件`)

    variant.closed = await app.close().then(() => true).catch(() => false)
    app = undefined
    record('实例已正常关闭', variant.closed)
  } catch (error) {
    variant.error = String(error?.stack ?? error)
    variant.checks.push({ name: '执行异常', passed: false, detail: variant.error.split('\n')[0] })
    console.error(`   ✗ [${label}] 失败：${error}`)
  } finally {
    if (app) await app.close().catch(() => {})
  }
  return variant
}

let server
try {
  console.log(`[probe A] run 目录：${runDir}`)
  const vite = startViteServer({ port: VITE_PORT })
  server = vite.server
  await waitForServer(VITE_PORT)
  check('Vite dev server 就绪', true, `http://127.0.0.1:${VITE_PORT}`)

  const playwright = loadPlaywright()
  const { env: probeEnv, sanitized } = electronEnv()
  result.env = sanitized
  check('启动前清除 ELECTRON_RUN_AS_NODE', true, `宿主环境原值 ${sanitized.ELECTRON_RUN_AS_NODE ?? '未设置'}`)

  const prodBefore = PROD_USER_DATA.map((dir) => dirSignature(dir))
  result.productionUserData = prodBefore.map((before) => ({ before }))

  // A1：launcher.cjs + app.setPath('userData')
  const a1UserData = resolve(runDir, 'user-data-a1')
  const launcherPath = resolve(runDir, 'launcher.cjs')
  writeFileSync(
    launcherPath,
    `const {app}=require('electron');app.setPath('userData',${JSON.stringify(a1UserData)});require(${JSON.stringify(resolve(REPO_ROOT, 'dist-electron', 'main.cjs'))});\n`,
    'utf8',
  )
  result.variants.push(await runVariant(playwright, {
    label: 'A1-launcher-setPath',
    args: [launcherPath],
    userDataDir: a1UserData,
    notes: 'run 目录内注入 launcher，setPath 后加载现有主 bundle（既有临时驱动做法）',
  }))

  // A2：app 路径 + Electron 原生 --user-data-dir
  const a2UserData = resolve(runDir, 'user-data-a2')
  result.variants.push(await runVariant(playwright, {
    label: 'A2-user-data-dir',
    args: ['.', `--user-data-dir=${a2UserData}`],
    userDataDir: a2UserData,
    notes: '以仓库为 app 路径启动，用原生开关隔离，不注入 launcher',
  }))

  // 跨变体对照
  const [a1, a2] = result.variants
  check('两种启动方式都能驱动现有应用',
    a1?.mainProcess && a2?.mainProcess && !a1.error && !a2.error,
    `A1=${a1?.mainProcess ? 'ok' : 'fail'} A2=${a2?.mainProcess ? 'ok' : 'fail'}`)
  check('A2（原生开关）能读到正确产品版本与名称',
    a2?.mainProcess?.version === '0.18.0' && ['轻语', 'qingyu'].includes(a2?.mainProcess?.name),
    `version=${a2?.mainProcess?.version} name=${a2?.mainProcess?.name}`)
  check('A1（注入 launcher）appPath 落在 run 目录，版本/名称取不到产品值',
    a1?.mainProcess?.version !== '0.18.0' && a1?.mainProcess?.appPath === runDir,
    `A1 version=${a1?.mainProcess?.version}（Electron 版本）appPath=${a1?.mainProcess?.appPath}`)

  for (const dir of PROD_USER_DATA) {
    const before = prodBefore[PROD_USER_DATA.indexOf(dir)]
    const after = dirSignature(dir)
    const entry = result.productionUserData.find((item) => item.before.path === dir)
    entry.after = after
    entry.unchanged = sameSignature(before, after)
    check(`正式数据目录未被触碰：${dir}`, entry.unchanged, entry.unchanged ? 'mtime/条目数/文件数一致' : `${before.mtime} → ${after.mtime}`)
  }
} catch (error) {
  result.errors.push(String(error?.stack ?? error))
  console.error('[probe A] 顶层失败：', error)
} finally {
  if (server) server.kill()
}

const perVariantChecks = result.variants.flatMap((variant) => variant.checks)
result.passed = result.checks.every((item) => item.passed) &&
  perVariantChecks.every((item) => item.passed) &&
  result.errors.length === 0
result.finishedAt = nowIso()
writeJson(resolve(runDir, 'result.json'), result)

const lines = []
lines.push('# 阶段 0 探针 A：source-dev 源码模式外部驱动')
lines.push('')
lines.push(`- 结果：${result.passed ? '✅ 通过' : '❌ 未通过'}`)
lines.push(`- run 目录：\`${runDir}\``)
lines.push(`- 宿主环境：\`ELECTRON_RUN_AS_NODE=${result.env?.ELECTRON_RUN_AS_NODE ?? '未设置'}\`（必须清除后才能启动 Electron）`)
lines.push('')
lines.push('## 1. 环境与前置检查')
lines.push('')
lines.push('| 检查项 | 结果 | 说明 |')
lines.push('|---|---|---|')
for (const item of result.checks) {
  lines.push(`| ${item.name} | ${item.passed ? '通过' : '未通过'} | ${item.detail === undefined ? '-' : String(JSON.stringify(item.detail)).replace(/\|/g, '\\|')} |`)
}
lines.push('')
lines.push('## 2. 两种隔离方式对照')
lines.push('')
lines.push('| 方式 | 启动参数 | 产品版本 | app 名称 | appPath | 主进程 userData | 隔离生效 |')
lines.push('|---|---|---|---|---|---|---|')
for (const variant of result.variants) {
  const main = variant.mainProcess ?? {}
  lines.push(`| ${variant.label} | \`${variant.launchArgs.map((a) => (a.length > 60 ? `${a.slice(0, 57)}…` : a)).join(' ')}\` | ${main.version ?? '-'} | ${main.name ?? '-'} | \`${main.appPath ?? '-'}\` | \`${main.userData ?? '-'}\` | ${variant.isolatedUserData?.files ?? 0} 文件 |`)
}
lines.push('')
for (const variant of result.variants) {
  lines.push(`### ${variant.label}`)
  lines.push('')
  lines.push(`- 说明：${variant.notes}`)
  lines.push(`- 证据：\`${variant.screenshot ?? '-'}\`、\`result.json\``)
  lines.push('')
  lines.push('| 检查项 | 结果 | 说明 |')
  lines.push('|---|---|---|')
  for (const item of variant.checks) {
    lines.push(`| ${item.name} | ${item.passed ? '通过' : '未通过'} | ${item.detail === undefined ? '-' : String(JSON.stringify(item.detail)).replace(/\|/g, '\\|')} |`)
  }
  if (variant.windows?.length) {
    lines.push('')
    lines.push('| 探测到的窗口 URL | window.api | 标题 |')
    lines.push('|---|---|---|')
    for (const item of variant.windows) lines.push(`| \`${item.url.slice(0, 120)}\` | ${item.apiType} | ${item.title} |`)
  }
  lines.push('')
}
lines.push('## 3. 只读调用结果（A1 实例）')
lines.push('')
lines.push('| 调用 | 结果 |')
lines.push('|---|---|')
for (const [name, value] of Object.entries(result.variants[0]?.invocations?.results ?? {})) {
  lines.push(`| ${name} | ${value.ok ? `ok · ${value.kind}${value.value === undefined ? '' : ` · ${value.value}`}` : `失败 · ${value.error}`} |`)
}
lines.push('')
lines.push(`故意漏参调用 \`chat.listSessions()\` 的返回：\`${result.variants[0]?.invocations?.missingArgError ?? '-'}\``)
if (result.errors.length) {
  lines.push('')
  lines.push('## 4. 错误')
  for (const error of result.errors) lines.push('```\n' + error + '\n```')
}
writeText(resolve(runDir, 'report.md'), `${lines.join('\n')}\n`)

console.log('')
console.log(`[probe A] ${result.passed ? '通过' : '未通过'}：${runDir}`)
process.exit(result.passed ? 0 : 1)
