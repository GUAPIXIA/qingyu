// 真实 Electron 子进程：父进程关闭 stdout/stderr 读端，日志应继续写文件并正常退出。
// 公共设施见 lib/electronHarness.mjs。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { buildElectronBundle, spawnElectronBundle } from './lib/electronHarness.mjs'

const root = resolve('output/logger-epipe')
mkdirSync(root, { recursive: true })
const directory = mkdtempSync(join(root, 'smoke-'))
const bundle = join(directory, 'probe.cjs')
const report = join(directory, 'result.json')
await buildElectronBundle({
  outfile: bundle,
  stdin: {
    contents: `import {app} from 'electron'; import {initLogger,createLogger} from './electron/services/logger'; import {writeFileSync} from 'node:fs'; app.setPath('userData',${JSON.stringify(directory)}); app.whenReady().then(()=>{initLogger(${JSON.stringify(directory)}); const log=createLogger('EPIPE-smoke'); log.debug('pipe closed debug'); log.info('pipe closed info'); log.warn('pipe closed warn'); log.error('pipe closed error'); writeFileSync(${JSON.stringify(report)},JSON.stringify({passed:true}));app.exit(0)})`,
    resolveDir: process.cwd(),
    sourcefile: 'epipe-probe.ts',
    loader: 'ts',
  },
})
const { child, exited } = spawnElectronBundle({ bundle, stdio: ['ignore', 'pipe', 'pipe'], timeoutMs: 15000 })
child.stdout.destroy()
child.stderr.destroy()
const code = await exited
const log = readFileSync(join(directory, 'logs/qingyu.log'), 'utf8')
if (code !== 0 || !existsSync(report) || !['debug', 'info', 'warn', 'error'].every(level => log.includes(`pipe closed ${level}`))) throw new Error('Electron closed-pipe smoke failed')
writeFileSync(join(root, 'result.json'), JSON.stringify({ passed: true, exitCode: code, directory, levels: ['debug', 'info', 'warn', 'error'] }, null, 2))
