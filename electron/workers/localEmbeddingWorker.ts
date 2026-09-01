import { parentPort } from 'node:worker_threads'
import type { LocalEmbeddingModelManifest } from '../../shared/localModels'

interface WorkerRequest {
  id: number
  type: 'embed' | 'unload'
  modelsRoot?: string
  manifest?: LocalEmbeddingModelManifest
  texts?: string[]
  inputKind?: 'query' | 'passage'
}

let loadedKey = ''
let extractor: ((texts: string[], options: Record<string, unknown>) => Promise<unknown>) | null = null

async function load(modelsRoot: string, manifest: LocalEmbeddingModelManifest) {
  const key = `${manifest.id}@${manifest.version}`
  if (extractor && loadedKey === key) return extractor
  const transformers = await import('@huggingface/transformers')
  transformers.env.allowRemoteModels = false
  transformers.env.allowLocalModels = true
  transformers.env.useFSCache = false
  transformers.env.localModelPath = modelsRoot.endsWith('/') || modelsRoot.endsWith('\\') ? modelsRoot : `${modelsRoot}/`
  extractor = await transformers.pipeline(
    'feature-extraction',
    `${manifest.id}/${manifest.version}`,
    { dtype: manifest.dtype },
  ) as unknown as typeof extractor
  loadedKey = key
  return extractor!
}

function toVectors(output: unknown): number[][] {
  const data = output as { tolist?: () => unknown }
  const raw = typeof data?.tolist === 'function' ? data.tolist() : output
  if (!Array.isArray(raw)) return []
  return raw.map((row) => Array.isArray(row) ? row.map(Number) : [])
}

parentPort?.on('message', async (request: WorkerRequest) => {
  try {
    if (request.type === 'unload') {
      extractor = null
      loadedKey = ''
      parentPort?.postMessage({ id: request.id, ok: true, result: [] })
      return
    }
    if (!request.modelsRoot || !request.manifest || !request.texts) throw new Error('本地模型 worker 请求不完整')
    const pipe = await load(request.modelsRoot, request.manifest)
    const prefix = request.inputKind === 'query' ? request.manifest.queryPrefix : request.manifest.passagePrefix
    const texts = request.texts.map((text) => `${prefix ?? ''}${text}`)
    const output = await pipe(texts, {
      pooling: request.manifest.pooling,
      normalize: request.manifest.normalize,
    })
    const vectors = toVectors(output)
    if (vectors.length !== texts.length || vectors.some((v) => v.length !== request.manifest!.dimensions || v.some((n) => !Number.isFinite(n)))) {
      throw new Error('本地模型返回的向量数量、维度或数值不合法')
    }
    parentPort?.postMessage({ id: request.id, ok: true, result: vectors })
  } catch (error) {
    parentPort?.postMessage({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) })
  }
})
