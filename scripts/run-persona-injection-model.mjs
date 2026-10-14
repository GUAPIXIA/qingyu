// 用户人设注入真机效果评测的 Electron 启动器（公共设施见 lib/electronHarness.mjs）。
import { runElectronBundle } from './lib/electronHarness.mjs'

process.exitCode = await runElectronBundle({
  entry: 'scripts/persona-injection-model-bench.ts',
  outfile: 'output/persona-injection-model/model-bench.cjs',
  args: process.argv.slice(2),
  logFile: 'output/persona-injection-model/process.log',
  target: 'node20',
})
