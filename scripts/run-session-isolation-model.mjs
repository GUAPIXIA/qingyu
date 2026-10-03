// 会话隔离真实模型基准的 Electron 启动器（公共设施见 lib/electronHarness.mjs）。
import { runElectronBundle } from './lib/electronHarness.mjs'

process.exitCode = await runElectronBundle({
  entry: 'scripts/session-isolation-model-bench.ts',
  outfile: 'output/session-isolation-model/model-bench.cjs',
  args: process.argv.slice(2),
  logFile: 'output/session-isolation-model/process.log',
  target: 'node20',
})
