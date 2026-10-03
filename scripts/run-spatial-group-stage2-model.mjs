// 群聊画板阶段 2 真实模型基准的 Electron 启动器（含 --resume 恢复模式）。
// 后台 Electron 直接继承日志文件句柄，父 shell 退出后也不会留下已关闭的输出管道。
// 公共设施见 lib/electronHarness.mjs。
import { resolve } from 'node:path'
import { runElectronBundle } from './lib/electronHarness.mjs'

const resume = process.argv[2] === '--resume'
if (process.argv.length > (resume ? 4 : 2) || (resume && !process.argv[3])) throw new Error('用法：node scripts/run-spatial-group-stage2-model.mjs [--resume 隔离目录]')
const entry = resume ? 'scripts/spatial-group-stage2-resume-bench.ts' : 'scripts/spatial-group-stage2-model-bench.ts'
process.exitCode = await runElectronBundle({
  entry,
  outfile: resume ? 'output/spatial-group-stage2/resume-bench.cjs' : 'output/spatial-group-stage2/model-bench.cjs',
  args: resume ? [resolve(process.argv[3])] : [],
  logFile: resume ? 'output/spatial-group-stage2/resume-process.log' : 'output/spatial-group-stage2/model-process.log',
})
