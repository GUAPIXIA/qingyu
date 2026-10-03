// 后台 Electron 直接继承日志文件句柄，父 shell 退出后也不会留下已关闭的输出管道。
import { spawn } from 'node:child_process'
import { openSync, closeSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { build } from 'esbuild'

const resume = process.argv[2] === '--resume'
if (process.argv.length > (resume ? 4 : 2) || (resume && !process.argv[3])) throw new Error('用法：node scripts/run-spatial-group-stage2-model.mjs [--resume 隔离目录]')
const output = resolve('output/spatial-group-stage2')
mkdirSync(output, {recursive:true})
const entry = resume ? 'spatial-group-stage2-resume-bench' : 'spatial-group-stage2-model-bench'
const bundle = join(output, resume ? 'resume-bench.cjs' : 'model-bench.cjs')
await build({entryPoints:[`scripts/${entry}.ts`],bundle:true,platform:'node',format:'cjs',target:'node18',external:['electron'],outfile:bundle})
const fd = openSync(join(output, resume ? 'resume-process.log' : 'model-process.log'), 'a')
const env = {...process.env}
delete env.ELECTRON_RUN_AS_NODE
let child
try {
  child = spawn(resolve('node_modules/electron/dist/electron.exe'), [bundle,...(resume ? [resolve(process.argv[3])] : [])], {cwd:process.cwd(),env,stdio:['ignore',fd,fd],windowsHide:true})
} finally { closeSync(fd) }
process.exitCode = await new Promise((resolveExit, reject) => {
  child.once('error', reject)
  child.once('exit', code => resolveExit(code ?? 1))
})
