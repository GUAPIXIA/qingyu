/**
 * ⚠️ 已废弃（2026-10-05）：阶段 0 一次性生成器，会以旧模板整体覆盖
 * `docs/架构/android-parity-matrix.md`（缺少「校正」表头行，且 PC entry 截断到 72 字符）。
 * 权威刷新入口为 `node scripts/refresh-parity-matrix.mjs`（由 JSON 渲染 md，二者保持一致）。
 * 仅作历史参考保留，请勿再运行。
 */
import { readFileSync, writeFileSync } from 'node:fs'

const m = JSON.parse(readFileSync('docs/架构/android-parity-matrix.json', 'utf8'))
const byTier = { P0: [], P1: [], P2: [] }
for (const c of m.capabilities) byTier[c.targetTier].push(c)

let md = `# Android 能力对齐矩阵（可读导出）

> 权威源：\`android-parity-matrix.json\`
> 生成：阶段0 代码入口审计（2026-09-16）

共 **${m.capabilities.length}** 项。

`

for (const t of ['P0', 'P1', 'P2']) {
  md += `## ${t}\n\n`
  md += '| capabilityId | 名称 | Android | platformPolicy | PC entry |\n'
  md += '|---|---|---|---|---|\n'
  for (const c of byTier[t]) {
    const entry = String(c.pcEntry).slice(0, 72)
    md += `| \`${c.capabilityId}\` | ${c.name} | ${c.androidStatus} | ${c.platformPolicy} | ${entry} |\n`
  }
  md += '\n'
}

md += `## 图例

- androidStatus: full / partial / none
- platformPolicy: same / equivalent / pc_only_confirmed
- targetTier: P0 / P1 / P2（总方案 §4）

## P0 关键缺口（伴侣端现状 → 独立客户端）

模型档案与连接测试、角色创建/编辑/导入导出、世界书管理、预设/人设/正则/快捷回复管理、凭据安全存储。
`

writeFileSync('docs/架构/android-parity-matrix.md', md)
console.log('wrote md', m.capabilities.length)
