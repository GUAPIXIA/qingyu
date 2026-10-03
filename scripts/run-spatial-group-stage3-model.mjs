// 后台 Electron 直接继承日志文件句柄，父 shell 退出后也不会留下已关闭的输出管道。
import { spawn } from 'node:child_process'
import { openSync, closeSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { build } from 'esbuild'

const output = resolve('output/spatial-group-stage3')
mkdirSync(output, {recursive:true})
const bundle = join(output,'model-bench.cjs')
await build({entryPoints:['scripts/spatial-group-stage3-model-bench.ts'],bundle:true,platform:'node',format:'cjs',target:'node18',external:['electron'],outfile:bundle})
const fd = openSync(join(output, 'model-process.log'), 'a')
const env = {...process.env}
delete env.ELECTRON_RUN_AS_NODE
let child
try {
  child = spawn(resolve('node_modules/electron/dist/electron.exe'), [bundle], {cwd:process.cwd(),env,stdio:['ignore',fd,fd],windowsHide:true})
} finally { closeSync(fd) }
process.exitCode = await new Promise((resolveExit, reject) => {
  child.once('error', reject)
  child.once('exit', code => resolveExit(code ?? 1))
})
