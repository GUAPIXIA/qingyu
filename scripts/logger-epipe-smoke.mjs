// 真实 Electron 子进程：父进程关闭 stdout/stderr 读端，日志应继续写文件并正常退出。
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
const root=resolve('output/logger-epipe')
mkdirSync(root,{recursive:true})
const directory=mkdtempSync(join(root,'smoke-')), bundle=join(directory,'probe.cjs'), report=join(directory,'result.json')
await build({stdin:{contents:`import {app} from 'electron'; import {initLogger,createLogger} from './electron/services/logger'; import {writeFileSync} from 'node:fs'; app.setPath('userData',${JSON.stringify(directory)}); app.whenReady().then(()=>{initLogger(${JSON.stringify(directory)}); const log=createLogger('EPIPE-smoke'); log.debug('pipe closed debug'); log.info('pipe closed info'); log.warn('pipe closed warn'); log.error('pipe closed error'); writeFileSync(${JSON.stringify(report)},JSON.stringify({passed:true}));app.exit(0)})`,resolveDir:process.cwd(),sourcefile:'epipe-probe.ts',loader:'ts'},bundle:true,platform:'node',format:'cjs',target:'node18',external:['electron'],outfile:bundle})
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
const child=spawn(resolve('node_modules/electron/dist/electron.exe'),[bundle],{env,stdio:['ignore','pipe','pipe'],windowsHide:true})
child.stdout.destroy();child.stderr.destroy()
const code=await new Promise((resolveExit,reject)=>{
  const timer=setTimeout(()=>{child.kill();reject(new Error('Electron closed-pipe smoke timeout'))},15000)
  child.once('error',error=>{clearTimeout(timer);reject(error)})
  child.once('exit',value=>{clearTimeout(timer);resolveExit(value)})
})
const log=readFileSync(join(directory,'logs/qingyu.log'),'utf8')
if(code!==0||!existsSync(report)||!['debug','info','warn','error'].every(level=>log.includes(`pipe closed ${level}`)))throw new Error('Electron closed-pipe smoke failed')
writeFileSync(join(root,'result.json'),JSON.stringify({passed:true,exitCode:code,directory,levels:['debug','info','warn','error']},null,2))
