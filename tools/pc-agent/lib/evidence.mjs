// 证据目录：output/pc-agent/<run-id>/（方案 §8 结构）
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export function createRunDir(root, label) {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const dir = resolve(root, `${label}-${stamp}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

export class Evidence {
  constructor(runDir) {
    this.runDir = runDir
    this.paths = {
      session: resolve(runDir, 'session.json'),
      actions: resolve(runDir, 'actions.jsonl'),
      assertions: resolve(runDir, 'assertions.jsonl'),
      result: resolve(runDir, 'result.json'),
      report: resolve(runDir, 'report.md'),
      screenshots: resolve(runDir, 'screenshots'),
      logs: resolve(runDir, 'logs'),
      exports: resolve(runDir, 'exports'),
      runtime: resolve(runDir, 'runtime'),
      userData: resolve(runDir, 'runtime', 'user-data'),
      token: resolve(runDir, 'runtime', 'token'),
      hostLock: resolve(runDir, 'runtime', 'host.lock'),
    }
    for (const dir of [this.paths.screenshots, this.paths.logs, this.paths.exports, this.paths.runtime, this.paths.userData]) {
      mkdirSync(dir, { recursive: true })
    }
  }

  writeSession(info) {
    writeJson(this.paths.session, info)
  }

  appendAction(record) {
    appendJsonl(this.paths.actions, record)
  }

  appendAssertion(record) {
    appendJsonl(this.paths.assertions, record)
  }

  readActions() {
    return readJsonl(this.paths.actions)
  }

  readAssertions() {
    return readJsonl(this.paths.assertions)
  }

  writeResult(result) {
    writeJson(this.paths.result, result)
  }

  writeReport(title, lines) {
    writeFileSync(this.paths.report, `# ${title}\n\n${lines.join('\n')}\n`, 'utf8')
  }

  screenshotPath(name) {
    return resolve(this.paths.screenshots, name)
  }

  logPath(name) {
    return resolve(this.paths.logs, name)
  }

  writeToken(token) {
    mkdirSync(dirname(this.paths.token), { recursive: true })
    // 私有连接令牌：只落在 run 目录的 runtime/ 下，不进公开 manifest、不入 Git
    writeFileSync(this.paths.token, token, { encoding: 'utf8', mode: 0o600 })
  }

  readToken() {
    return existsSync(this.paths.token) ? readFileSync(this.paths.token, 'utf8').trim() : null
  }
}

export function writeJson(absPath, value) {
  mkdirSync(dirname(absPath), { recursive: true })
  writeFileSync(absPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

export function writeText(absPath, value) {
  mkdirSync(dirname(absPath), { recursive: true })
  writeFileSync(absPath, value, 'utf8')
}

export function readJson(absPath) {
  return JSON.parse(readFileSync(absPath, 'utf8'))
}

export function appendJsonl(absPath, record) {
  mkdirSync(dirname(absPath), { recursive: true })
  appendFileSync(absPath, `${JSON.stringify(record)}\n`, 'utf8')
}

export function readJsonl(absPath) {
  if (!existsSync(absPath)) return []
  return readFileSync(absPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
}
