import { spawn } from 'node:child_process'
import { openSync, closeSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { build } from 'esbuild'

const output = resolve('output/session-isolation-model')
mkdirSync(output, { recursive: true })
const bundle = join(output, 'model-bench.cjs')
await build({ entryPoints: ['scripts/session-isolation-model-bench.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['electron'], outfile: bundle })
const fd = openSync(join(output, 'process.log'), 'a')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
let child
try {
  child = spawn(resolve('node_modules/electron/dist/electron.exe'), [bundle, ...process.argv.slice(2)], { cwd: process.cwd(), env, stdio: ['ignore', fd, fd], windowsHide: true })
} finally { closeSync(fd) }
process.exitCode = await new Promise((resolveExit, reject) => {
  child.once('error', reject)
  child.once('exit', code => resolveExit(code ?? 1))
})
