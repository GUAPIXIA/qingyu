// 一个受控自动化会话：隔离启动、窗口识别、单写者队列、动作执行、重启与收尾。
// 阶段 1 支持 profile：source-isolated（源码 + Vite dev server + 隔离 userData）
//                          packaged-isolated（打包产物 + --user-data-dir + CDP）
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, openSync, readFileSync, readdirSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { checkPermission, describeAction, dispatchAction, loadActions, unwrapDispatch, validateArgs } from './actions.mjs'
import { summarizeAssertions } from './assertions.mjs'
import { resolveTaskId, waitForTask } from './async-wait.mjs'
import { redactResult } from './redaction.mjs'
import { Evidence } from './evidence.mjs'
import {
  REPO_ROOT,
  assertSupportedPlatform,
  buildIdentity,
  electronExecutable,
  packagedExecutable,
  sanitizedEnv,
} from '../platform.mjs'

const DEV_SERVER_URL = 'http://localhost:5173'
const PACKAGED_URL_MARKER = 'dist/index.html'

/** 异步等待结果 → 动作状态（方案 §5.4） */
const TASK_OUTCOME_STATUS = {
  completed: 'succeeded',
  failed: 'failed',
  cancelled: 'cancelled',
  interrupted: 'unknown',
  not_found: 'unknown',
  timeout: 'timeout',
}

let playwrightModule = null
async function loadPlaywright() {
  if (!playwrightModule) playwrightModule = await import('playwright-core')
  return playwrightModule
}

function redactArgs(args) {  const redact = (value, depth = 0) => {
    if (depth > 4) return '[deep]'
    if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1))
    if (value && typeof value === 'object') {
      const output = {}
      for (const [key, item] of Object.entries(value)) {
        output[key] = /key|token|secret|password|credential/i.test(key) ? '[redacted]' : redact(item, depth + 1)
      }
      return output
    }
    return value
  }
  return redact(args)
}

export class Session {
  constructor({ host, runDir, profile, allowedWriteModules, allowStaleBuild, allowCredentialWrite, label }) {
    this.host = host
    this.profile = profile
    this.runDir = runDir
    this.allowedWriteModules = allowedWriteModules ?? []
    this.allowStaleBuild = Boolean(allowStaleBuild)
    this.allowCredentialWrite = Boolean(allowCredentialWrite)
    this.label = label ?? profile
    this.evidence = new Evidence(runDir)
    this.userDataDir = this.evidence.paths.userData
    this.state = 'created'
    this.startedAt = new Date().toISOString()
    this.operationCounter = 0
    this.actionRecords = []
    this.assertionRecords = []
    this.queue = Promise.resolve()
    this.windows = []
    this.ownedVite = false
    this.viteProcess = null
    this.electronApp = null
    this.cdpBrowser = null
    this.packagedChild = null
    this.page = null
    this.build = null
    this.actions = loadActions()
  }

  /** 单写者队列：同一会话内的写动作与生命周期操作串行执行 */
  enqueue(task) {
    const run = this.queue.then(task, task)
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  publicInfo() {
    return {
      sessionId: this.id,
      profile: this.profile,
      label: this.label,
      state: this.state,
      runDir: this.runDir,
      userDataDir: this.userDataDir,
      startedAt: this.startedAt,
      allowedWriteModules: this.allowedWriteModules,
      host: { hostId: this.host.hostId, pid: this.host.pid, pipe: this.host.pipePath },
      platform: process.platform,
      electronPid: this.electronPid ?? null,
      build: this.build,
      windows: this.windows.map((window) => ({ url: window.url, api: window.apiType, kind: window.kind })),
      operations: this.operationCounter,
    }
  }

  async start() {
    return this.enqueue(async () => {
      assertSupportedPlatform()

      // 安全边界：隔离 userData 必须位于本次 run 目录下（方案 §4.4）
      const runPrefix = resolve(this.runDir) + sep
      if (!resolve(this.userDataDir).startsWith(runPrefix)) {
        const error = new Error(`拒绝启动：隔离 userData 不在 run 目录内（${this.userDataDir}）`)
        error.code = 'UNSAFE_USER_DATA'
        throw error
      }

      // 会话令牌：只落在 run 目录的 runtime/ 下，并登记到宿主可用令牌集合
      this.token = randomBytes(24).toString('hex')
      this.host.validTokens.add(this.token)

      this.build = buildIdentity()
      if (this.build.stale && !this.allowStaleBuild) {
        const error = new Error(`构建陈旧，拒绝启动：\n  - ${this.build.staleReasons.join('\n  - ')}\n  处理：pnpm electron:preview（源码）或 pnpm electron:build（打包）；确需继续可加 --allow-stale-build`)
        error.code = 'STALE_BUILD'
        throw error
      }

      this.evidence.writeToken(this.token)
      await this.launch()
      this.state = 'running'
      this.evidence.writeSession(this.publicInfo())
      return this.publicInfo()
    })
  }

  async launch() {
    // 长会话内反复启动 Electron 会在某个上限后失败（实测 exitCode=3221225794 = DLL 初始化失败，
    // 与宿主进程累积状态有关）。失败后延迟重试一次；仍失败则给出明确错误码并把会话置为 error。
    try {
      return await this.#launchOnce()
    } catch (error) {
      this.launchFailures = (this.launchFailures ?? 0) + 1
      if (this.launchFailures <= 1) {
        await new Promise((done) => setTimeout(done, 3000))
        return this.#launchOnce()
      }
      const wrapped = new Error(
        `Electron 启动失败（本会话累计 ${this.launchFailures} 次）：${error.message}\n` +
        '  已知约束：同一宿主进程内反复启动 Electron 有上限（本机约 20 次后报 DLL 初始化失败）。\n' +
        '  处理：关闭本会话后新建（session close → session start），或把长矩阵拆成小批运行。',
      )
      wrapped.code = 'ELECTRON_LAUNCH_FAILED'
      this.state = 'error'
      this.lastLaunchError = wrapped.message
      throw wrapped
    }
  }

  async #launchOnce() {
    if (this.profile === 'source-isolated') return this.launchSource()
    if (this.profile === 'packaged-isolated') return this.launchPackaged()
    const error = new Error(`不支持的 profile：${this.profile}`)
    error.code = 'UNSUPPORTED_PROFILE'
    throw error
  }

  async ensureDevServer() {
    const ready = async () => {
      try {
        return (await fetch(DEV_SERVER_URL)).ok
      } catch {
        return false
      }
    }
    if (await ready()) {
      this.ownedVite = false
      return { reused: true }
    }
    const logPath = this.evidence.logPath('vite.log')
    const out = openSync(logPath, 'a')
    this.viteProcess = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5173', '--strictPort'], {
      cwd: REPO_ROOT,
      stdio: ['ignore', out, out],
      windowsHide: true,
    })
    this.ownedVite = true
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (await ready()) return { reused: false }
      await new Promise((done) => setTimeout(done, 500))
    }
    throw new Error('Vite dev server 未在 60s 内就绪')
  }

  async launchSource() {
    const { reused } = await this.ensureDevServer()
    const { env, sanitized } = sanitizedEnv()
    const playwright = await loadPlaywright()
    this.electronApp = await playwright._electron.launch({
      executablePath: electronExecutable(),
      args: ['.', `--user-data-dir=${this.userDataDir}`],
      cwd: REPO_ROOT,
      env,
      timeout: 60000,
    })
    this.electronPid = this.electronApp.process()?.pid ?? null
    this.envSanitized = sanitized
    this.devServerReused = reused
    await this.bindWindow()
  }

  async launchPackaged() {
    const executable = packagedExecutable()
    if (!existsSync(executable)) {
      const error = new Error(`打包产物不存在：${executable}（先运行 pnpm electron:build）`)
      error.code = 'PACKAGED_MISSING'
      throw error
    }
    const { env } = sanitizedEnv()
    const port = this.host.debugPort
    this.packagedChild = spawn(executable, [`--user-data-dir=${this.userDataDir}`, `--remote-debugging-port=${port}`], {
      cwd: resolve(executable, '..'),
      env,
      stdio: 'ignore',
    })
    this.electronPid = this.packagedChild.pid ?? null
    const playwright = await loadPlaywright()
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`)
        if (response.ok) break
      } catch {
        // 未就绪
      }
      await new Promise((done) => setTimeout(done, 500))
    }
    // 安全闸门：先确认隔离目录被写入，再继续（方案 §4.4）
    const populated = this.isUserDataPopulated()
    if (!populated) {
      await this.closeElectron()
      const error = new Error('隔离未生效：隔离 userData 未被写入，已终止以避免触碰正式数据')
      error.code = 'ISOLATION_NOT_EFFECTIVE'
      throw error
    }
    this.cdpBrowser = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    await this.bindWindow()
  }

  isUserDataPopulated() {
    try {
      return readdirSync(this.userDataDir).length > 0
    } catch {
      return false
    }
  }

  /** 事件型异步：轮询任务快照直到终态（方案 §6.2） */
  async waitForActionTask(action, taskId) {
    const config = action.awaitTask ?? {}
    const pollApiPath = config.poll ?? 'window.api.chatTask.get'
    const apiPath = pollApiPath.startsWith('window.api.') ? pollApiPath : `window.api.${pollApiPath}`
    return waitForTask({
      taskId,
      timeoutMs: config.timeoutMs ?? 120000,
      pollMs: config.pollMs ?? 500,
      fetchTask: async (id) => {
        const raw = await dispatchAction(this.page, { apiPath }, [id])
        const value = unwrapDispatch(raw)
        // 轮询源可能返回数组（如 localModel.tasks），按 taskId 取对应快照
        if (Array.isArray(value)) return value.find((item) => item?.taskId === id) ?? null
        return value
      },
      onProgress: (snapshot) => { this.lastTaskSnapshot = snapshot },
      cancel: config.cancelAction
        ? async () => { await dispatchAction(this.page, { apiPath: `window.api.${config.cancelAction.replace(/^window\.api\./, '')}` }, [taskId]) }
        : null,
    })
  }

  /** 采集渲染层未捕获异常与 console.error：缺陷取证需要原始错误文本 */
  attachRendererDiagnostics(page) {
    this.diagnosticsPages = this.diagnosticsPages ?? new WeakSet()
    if (this.diagnosticsPages.has(page)) return
    this.diagnosticsPages.add(page)
    this.rendererErrors = this.rendererErrors ?? []
    const record = (source, text) => {
      const entry = { at: new Date().toISOString(), source, text: String(text).slice(0, 500) }
      this.rendererErrors.push(entry)
      try {
        appendFileSync(this.evidence.logPath('renderer.log'), `${JSON.stringify(entry)}\n`, 'utf8')
      } catch {
        // 日志写入失败不应影响会话
      }
    }
    page.on('pageerror', (error) => record('pageerror', error?.message ?? String(error)))
    page.on('console', (message) => {
      if (message.type() === 'error') record('console', message.text())
    })
  }

  /** 窗口识别：URL + window.api 可用性综合判定，排除 devtools://（方案 §4.2） */
  async bindWindow(timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs
    let latest = []
    while (Date.now() < deadline) {
      const pages = this.profile === 'packaged-isolated'
        ? this.cdpBrowser?.contexts()?.[0]?.pages() ?? []
        : this.electronApp?.windows() ?? []

      latest = []
      for (const page of pages) {
        let apiType = 'n/a'
        try {
          apiType = await page.evaluate(() => typeof window.api)
        } catch (error) {
          apiType = `error: ${String(error?.message ?? error).split('\n')[0]}`
        }
        const url = page.url()
        latest.push({
          url,
          apiType,
          kind: url.startsWith('devtools://') ? 'devtools' : apiType === 'object' ? 'main' : 'unknown',
        })
      }
      this.windows = latest
      const main = pages.find((page, index) => latest[index]?.kind === 'main' && this.matchesMainUrl(latest[index].url))
      if (main) {
        this.page = main
        this.attachRendererDiagnostics(main)
        return main
      }
      await new Promise((done) => setTimeout(done, 500))
    }
    const error = new Error(`未在 ${timeoutMs}ms 内识别到主窗口；已见窗口：${latest.map((item) => `${item.url.slice(0, 60)}(${item.apiType})`).join(' | ')}`)
    error.code = 'WINDOW_NOT_FOUND'
    throw error
  }

  matchesMainUrl(url) {
    if (this.profile === 'source-isolated') return url.includes('localhost:5173') || url.includes('127.0.0.1:5173')
    return url.startsWith('file://') && url.includes(PACKAGED_URL_MARKER)
  }

  async invoke(actionId, args = [], options = {}) {
    // 控制类动作（取消/停止）必须绕过单写者队列，否则会排在被取消的动作之后
    const action = this.actions.all.get(actionId)
    if (action?.control === true) return this.#invokeNow(actionId, args, options)
    return this.enqueue(() => this.#invokeNow(actionId, args, options))
  }

  async #invokeNow(actionId, args = [], { purpose = 'invoke', allowWrite = true, wait = true } = {}) {
    {
      const started = Date.now()
      this.operationCounter += 1
      const operationId = `op-${String(this.operationCounter).padStart(4, '0')}`
      const record = {
        at: new Date().toISOString(),
        operationId,
        action: actionId,
        purpose,
        args: redactArgs(args),
        layer: null,
        status: 'failed',
        invoked: false,
        verified: false,
        targets: [],
        elapsedMs: 0,
        error: null,
      }

      const finish = (outcome) => {
        record.elapsedMs = Date.now() - started
        this.actionRecords.push(record)
        this.evidence.appendAction(record)
        return outcome
      }

      if (this.state !== 'running' || !this.page) {
        record.status = 'blocked'
        const hint = this.state === 'error'
          ? '；会话已进入 error：可 session restart 重试，或关闭后新建会话（长矩阵请分批）'
          : ''
        record.error = { code: 'SESSION_NOT_RUNNING', message: `会话状态为 ${this.state}，无法执行动作${hint}` }
        return finish({ ...this.#base(actionId, operationId), status: 'blocked', invoked: false, verified: false, error: record.error, record })
      }

      const action = this.actions.all.get(actionId)
      if (!action) {
        record.status = 'rejected'
        record.error = { code: 'UNKNOWN_ACTION', message: `目录中不存在动作：${actionId}` }
        return finish({ ...this.#base(actionId, operationId), status: 'rejected', invoked: false, verified: false, error: record.error, record })
      }
      if (action.status !== 'mapped') {
        const requirements = action.requires ?? []
        if (requirements.includes('native-dialog')) {
          // 方案 §6.3：桌面自动化后端实测不可靠（见 docs/报告/PC端外部Agent工具阶段5实施报告），
          // 因此统一返回 needs_interaction 并给出交互路径，保持任务可恢复。
          record.status = 'needs_interaction'
          record.error = {
            code: 'NEEDS_NATIVE_DIALOG',
            message: `需要系统原生对话框，工具不代为完成（后端实测不可靠）：${action.pendingReason ?? '（未登记原因）'}`,
          }
          return finish({ ...this.#base(actionId, operationId), status: 'needs_interaction', invoked: false, verified: false, layer: action.layer, error: record.error, record })
        }
        record.status = 'blocked'
        record.error = {
          code: 'PENDING_ENVIRONMENT',
          message: `动作尚未验证：需要环境（${requirements.join(', ') || '未登记'}）——${action.pendingReason ?? '未登记原因'}`,
        }
        return finish({ ...this.#base(actionId, operationId), status: 'blocked', invoked: false, verified: false, layer: action.layer, error: record.error, record })
      }

      // 免对话框语义：动作声明 dialog.pathArg 且调用方传了该路径 → 不弹对话框，直接执行；
      // 未传路径 → 产品会弹对话框，此时如实返回 needs_interaction（不实际调用，避免挂死）。
      const dialogSpec = action.dialog
      if (dialogSpec && Number.isInteger(dialogSpec.pathArg)) {
        const supplied = args[dialogSpec.pathArg]
        const hasPath = (typeof supplied === 'string' && supplied.trim() !== '')
          || (Array.isArray(supplied) && supplied.some((item) => typeof item === 'string' && item.trim() !== ''))
        if (!hasPath) {
          record.status = 'needs_interaction'
          record.error = {
            code: 'NEEDS_NATIVE_DIALOG',
            message: `未提供路径参数（args[${dialogSpec.pathArg}]），产品会弹系统对话框；请传入${dialogSpec.kind === 'save' ? ' targetPath' : ' sourcePath'} 以跳过对话框`,
          }
          return finish({ ...this.#base(actionId, operationId), status: 'needs_interaction', invoked: false, verified: false, layer: action.layer, error: record.error, record })
        }
      }

      record.layer = action.layer
      // 凭据写入默认关闭：只有会话显式授权才放行（方案 §4.4；用于已授权的真实模型验证）
      if ((action.requires ?? []).includes('credential-write') && !this.allowCredentialWrite) {
        record.status = 'blocked'
        record.error = {
          code: 'CREDENTIAL_WRITE_NOT_ALLOWED',
          message: '凭据写入默认关闭：需在 session start 时显式加 --allow-credential-write（仅用于已授权的真实模型验证）',
        }
        return finish({ ...this.#base(actionId, operationId), status: 'blocked', invoked: false, verified: false, layer: action.layer, error: record.error, record })
      }
      const permissionError = allowWrite ? checkPermission(action, this.allowedWriteModules) : null
      if (permissionError) {
        record.status = 'blocked'
        record.error = { code: 'NOT_AUTHORIZED', message: permissionError }
        return finish({ ...this.#base(actionId, operationId), status: 'blocked', invoked: false, verified: false, layer: action.layer, error: record.error, record })
      }

      const argsError = validateArgs(action, args)
      if (argsError) {
        record.status = 'rejected'
        record.error = { code: 'INVALID_ARGS', message: argsError }
        return finish({ ...this.#base(actionId, operationId), status: 'rejected', invoked: false, verified: false, layer: action.layer, error: record.error, record })
      }

      try {
        const raw = await dispatchAction(this.page, action, args)
        let result = unwrapDispatch(raw)
        // 结果脱敏：按动作登记的 redactKeys 剔除敏感字段后再返回（方案 §4.4）
        const redaction = redactResult(result, action.redactKeys)
        result = redaction.value
        record.status = 'succeeded'
        record.invoked = true
        record.targets = collectTargets(result)
        record.resultDigest = digest(result)
        if (redaction.removed.length > 0) record.redacted = redaction.removed
        if (raw && typeof raw === 'object' && raw.__steps) record.uiSteps = raw.__steps

        // 事件型异步：动作声明 awaitTask 时，轮询任务快照直到终态（方案 §6.2）
        if (action.awaitTask) {
          const taskId = resolveTaskId(result, action.awaitTask.path ?? 'taskId')
          if (!taskId) {
            record.status = 'unknown'
            record.error = { code: 'NO_TASK_ID', message: `动作未返回任务 id（期望 ${action.awaitTask.path ?? 'taskId'}），无法证明提交结果` }
            return finish({ ...this.#base(actionId, operationId), status: 'unknown', layer: action.layer, invoked: true, verified: false, result, error: record.error, record })
          }
          // wait=false：只返回异步句柄（accepted），由调用方用 chatTask.get / operation 查询或取消
          if (wait === false) {
            const handle = { taskId, outcome: 'accepted', state: null, submitted: result }
            record.status = 'accepted'
            record.task = { taskId, outcome: 'accepted', polls: 0, elapsedMs: Date.now() - started, state: null }
            record.resultDigest = digest(handle)
            return finish({
              ...this.#base(actionId, operationId),
              status: 'accepted',
              layer: action.layer,
              invoked: true,
              verified: false,
              result: handle,
              targets: record.targets,
              redacted: redaction.removed,
              error: null,
              record,
            })
          }
          const waited = await this.waitForActionTask(action, taskId)
          record.task = { taskId, outcome: waited.outcome, polls: waited.polls, elapsedMs: waited.elapsedMs, state: waited.snapshot?.state ?? null }
          record.status = TASK_OUTCOME_STATUS[waited.outcome] ?? 'unknown'
          record.elapsedMs = Date.now() - started
          const asyncResult = {
            taskId,
            outcome: waited.outcome,
            state: waited.snapshot?.state ?? null,
            lastSequence: waited.snapshot?.lastSequence ?? null,
            usage: waited.snapshot?.usage ?? null,
            accumulatedText: waited.snapshot?.accumulatedText ?? null,
            submitted: result,
          }
          const asyncError = waited.outcome === 'failed' || waited.outcome === 'not_found' || waited.outcome === 'timeout'
            ? { code: `TASK_${waited.outcome.toUpperCase()}`, message: waited.snapshot?.error?.message ?? `任务结果：${waited.outcome}` }
            : null
          record.error = asyncError
          record.resultDigest = digest(asyncResult)
          return finish({
            ...this.#base(actionId, operationId),
            status: record.status,
            layer: action.layer,
            invoked: true,
            verified: false,
            result: asyncResult,
            targets: record.targets,
            redacted: redaction.removed,
            error: asyncError,
            record,
          })
        }

        return finish({ ...this.#base(actionId, operationId), status: 'succeeded', layer: action.layer, invoked: true, verified: false, result, targets: record.targets, redacted: redaction.removed, error: null, record })
      } catch (error) {
        record.error = { code: error.code ?? 'ACTION_FAILED', message: String(error.message) }
        record.status = 'failed'
        return finish({ ...this.#base(actionId, operationId), status: 'failed', layer: action.layer, invoked: true, verified: false, error: record.error, record })
      }
    }
  }

  #base(actionId, operationId) {
    return { schemaVersion: 1, sessionId: this.id, operationId, action: actionId, evidence: [] }
  }

  async observe(actionId, args = []) {
    const outcome = await this.invoke(actionId, args, { purpose: 'observe', allowWrite: false })
    return outcome
  }

  async screenshot(name) {
    if (!this.page) return null
    const target = this.evidence.screenshotPath(name)
    await this.page.screenshot({ path: target, timeout: 20000 }).catch(() => {})
    return target
  }

  /** 重启：只重启应用，Vite 与会话 run 目录保持不变；重启后重新绑定窗口/页面 */
  async restart() {
    return this.enqueue(async () => {
      this.state = 'restarting'
      await this.closeElectron()
      this.page = null
      this.windows = []
      try {
        await this.launch()
        this.state = 'running'
        this.restarts = (this.restarts ?? 0) + 1
        return this.publicInfo()
      } catch (error) {
        // 失败不能停在 'restarting'（那会让后续所有动作都判 blocked 且无法恢复）
        this.state = 'error'
        this.lastError = String(error.message)
        throw error
      }
    })
  }

  async closeElectron() {
    if (this.electronApp) {
      await this.electronApp.close().catch(() => {})
      this.electronApp = null
    }
    if (this.cdpBrowser) {
      await this.cdpBrowser.close().catch(() => {})
      this.cdpBrowser = null
    }
    if (this.packagedChild?.pid) {
      const { killTree } = await import('./process.mjs')
      killTree(this.packagedChild.pid)
      this.packagedChild = null
      await new Promise((done) => setTimeout(done, 1500))
    }
  }

  async close({ reason = 'normal', evidenceReport = null } = {}) {
    return this.enqueue(async () => {
      await this.closeElectron()
      if (this.ownedVite && this.viteProcess) {
        this.viteProcess.kill()
        this.viteProcess = null
      }
      this.state = 'closed'
      const summary = {
        sessionId: this.id,
        profile: this.profile,
        runDir: this.runDir,
        reason,
        closedAt: new Date().toISOString(),
        build: this.build,
        userDataPreserved: true,
        restarts: this.restarts ?? 0,
        actions: summarize(this.actionRecords),
        assertions: summarizeAssertions(this.assertionRecords),
        rendererErrors: (this.rendererErrors ?? []).length,
      }
      this.evidence.writeResult(summary)
      if (evidenceReport) this.evidence.writeReport(evidenceReport.title, evidenceReport.lines)
      return summary
    })
  }

  recordAssertion(record) {
    this.assertionRecords.push(record)
    this.evidence.appendAssertion(record)
  }

  describe(actionId) {
    const action = this.actions.all.get(actionId)
    return action ? describeAction(action) : null
  }
}

function collectTargets(result) {
  if (!result || typeof result !== 'object') return []
  const targets = []
  if (typeof result.id === 'string') targets.push({ type: 'entity', id: result.id })
  if (typeof result.characterId === 'string' && typeof result.id === 'string') targets.push({ type: 'chatSession', id: result.id })
  return targets
}

function digest(value) {
  if (value === null || value === undefined) return String(value)
  if (Array.isArray(value)) return `array(${value.length})`
  if (typeof value === 'object') return `object(keys=${Object.keys(value).length})`
  return String(value).slice(0, 120)
}

function summarize(records) {
  const byStatus = {}
  for (const record of records) byStatus[record.status] = (byStatus[record.status] ?? 0) + 1
  return { total: records.length, byStatus }
}

export function readSessionInfo(runDir) {
  const path = resolve(runDir, 'session.json')
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
}






