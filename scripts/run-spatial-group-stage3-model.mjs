// 群聊画板阶段 3 真实模型基准的 Electron 启动器（公共设施见 lib/electronHarness.mjs）。
import { runElectronBundle } from './lib/electronHarness.mjs'

process.exitCode = await runElectronBundle({
  entry: 'scripts/spatial-group-stage3-model-bench.ts',
  outfile: 'output/spatial-group-stage3/model-bench.cjs',
  logFile: 'output/spatial-group-stage3/model-process.log',
})
