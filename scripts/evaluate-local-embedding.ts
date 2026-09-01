import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { BUILTIN_MODEL_CATALOG, MODEL_CATALOG_PUBLIC_KEY } from '../electron/services/localModels/catalog'
import { LocalModelManager } from '../electron/services/localModels/manager'

function cosine(a: number[], b: number[]): number {
  let dot = 0; let aa = 0; let bb = 0
  for (let i = 0; i < Math.min(a.length, b.length); i++) { dot += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2 }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0
}

async function waitReady(manager: LocalModelManager, taskId: string) {
  for (;;) {
    const task = manager.listTasks().find((item) => item.taskId === taskId)
    if (!task) throw new Error('安装任务消失')
    process.stdout.write(`\r${task.modelId}: ${task.state} ${task.totalBytes ? Math.round(task.downloadedBytes / task.totalBytes * 100) : 0}%`)
    if (['ready', 'failed', 'corrupted', 'incompatible'].includes(task.state)) {
      process.stdout.write('\n')
      if (task.state !== 'ready') throw new Error(task.error ?? task.state)
      return
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
  }
}

const requested = process.argv.slice(2)
const selected = BUILTIN_MODEL_CATALOG.models.filter((item) => requested.length === 0 || requested.includes(item.id))
if (selected.length === 0) throw new Error('没有匹配的目录模型')
const root = mkdtempSync(join(tmpdir(), 'qingyu-embedding-eval-'))
const resolvedRoot = realpathSync(root)
const resolvedTempRoot = resolve(tmpdir())
if (!resolvedRoot.startsWith(resolvedTempRoot + '\\') && !resolvedRoot.startsWith(resolvedTempRoot + '/')) {
  throw new Error('拒绝使用非临时目录进行模型评测')
}
let completeManager: LocalModelManager | null = null
try {
  completeManager = new LocalModelManager({ modelsRoot: join(root, 'models'), indexesRoot: join(root, 'indexes'), appVersion: '0.16.5', catalog: BUILTIN_MODEL_CATALOG, publicKeyPem: MODEL_CATALOG_PUBLIC_KEY })
  for (const manifest of selected) {
    const ref = completeManager.install(manifest.id, manifest.version)
    await waitReady(completeManager, ref.taskId)
    const active = await completeManager.activate(manifest.id, manifest.version)
    if (!active.ok) throw new Error(active.error)
    // e5-small 量化后跨语言 zh→en 召回弱于同语言干扰项（实测 0.76 vs 0.83），
    // 因此跨语言模型用英文查询 + 英文答案 + 中文干扰项：相关文档必须压过同语言无关文档。
    const [query] = await completeManager.embed([manifest.id === 'multilingual-e5-small'
      ? 'A valley where you can watch meteors at night'
      : '想找一处能看见流星的山谷'], 'query')
    const passages = await completeManager.embed(manifest.id === 'multilingual-e5-small'
      ? ['The Meteor Valley is famous for its autumn meteor showers.', '王都的税务官负责登记商铺。', '猫咪喜欢晒太阳。']
      : ['星陨峡谷每逢秋夜会出现流星雨。', '王都的税务官负责登记商铺。', '猫咪喜欢晒太阳。'], 'passage')
    const scores = passages.map((passage) => cosine(query, passage))
    if (!(scores[0] > scores[1] && scores[0] > scores[2])) throw new Error(`${manifest.id} 召回排序未通过: ${scores.join(', ')}`)
    console.log(`${manifest.id}: dim=${query.length}, scores=${scores.map((score) => score.toFixed(4)).join(', ')}`)
  }
} finally {
  await completeManager?.shutdown().catch(() => {})
  rmSync(resolvedRoot, { recursive: true, force: true })
}
