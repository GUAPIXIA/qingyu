import type { LocalEmbeddingModelFile, LocalModelCatalog } from '../../../shared/localModels'

/** 发布目录公钥；私钥只存在于发布流程，不进入仓库。 */
export const MODEL_CATALOG_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAcbxzixM4KdNvnVdmVo5tr92qyzU0VAa8M8hkqLLgRDk=
-----END PUBLIC KEY-----`

function file(repo: string, revision: string, path: string, size: number, sha256: string): LocalEmbeddingModelFile {
  return { path, size, sha256, urls: [`https://huggingface.co/${repo}/resolve/${revision}/${path}`] }
}

const BGE_REPO = 'Xenova/bge-small-zh-v1.5'
const BGE_REVISION = '75c43b069aac4d136ba6bc1122f995fedcfd2781'
const E5_REPO = 'Xenova/multilingual-e5-small'
const E5_REVISION = '761b726dd34fb83930e26aab4e9ac3899aa1fa78'

/** 固定上游 commit、逐文件大小与 SHA-256；权重仅使用 ONNX q8 数据文件。 */
export const BUILTIN_MODEL_CATALOG: LocalModelCatalog = {
  schemaVersion: 1,
  generatedAt: '2026-08-28T11:15:00.000Z',
  models: [
    {
      schemaVersion: 1, id: 'bge-small-zh-v1.5', version: '1.0.0', displayName: '中文语义模型 Small',
      description: '面向中文对话与中文世界书的低配置推荐模型。', languages: ['中文'],
      license: { name: 'MIT', url: 'https://huggingface.co/BAAI/bge-small-zh-v1.5' }, runtime: 'onnx',
      architecture: 'BERT / BGE Small zh v1.5', dimensions: 512, maxTokens: 512, dtype: 'q8', pooling: 'mean', normalize: true,
      queryPrefix: '为这个句子生成表示以用于检索相关文章：', minimumAppVersion: '0.16.3', recommendedMemoryMb: 300, installedSize: 24_560_715,
      files: [
        file(BGE_REPO, BGE_REVISION, 'config.json', 716, 'd4193ead3a810fd694fa8a31d7fc72fbaebc0668b603e398734bf2f6538ff42f'),
        file(BGE_REPO, BGE_REVISION, 'onnx/model_quantized.onnx', 24_010_842, '15b717c382bcb518ba457b93ea6850ede7f4f1cd8937454aa06972366cd19bcc'),
        file(BGE_REPO, BGE_REVISION, 'special_tokens_map.json', 125, 'b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3'),
        file(BGE_REPO, BGE_REVISION, 'tokenizer.json', 439_125, '48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26'),
        file(BGE_REPO, BGE_REVISION, 'tokenizer_config.json', 367, 'e6f3b96db926a37d4039995fbf5ad17de158dfb8f6343d607e4dbaad18d75f5a'),
        file(BGE_REPO, BGE_REVISION, 'vocab.txt', 109_540, '45bbac6b341c319adc98a532532882e91a9cefc0329aa57bac9ae761c27b291c'),
      ],
      catalogSignature: 'J2J3NN4ZyhF2NFVRHeRIP/uVQTUYATx1nOuEqWiHAUMhkoWefN/VGcCASjHHYFlXiONXiVR+q52DZr6iePC3AA==',
    },
    {
      schemaVersion: 1, id: 'multilingual-e5-small', version: '1.0.0', displayName: '多语言语义模型 Small',
      description: '面向英文世界书与中文对话的可选模型；跨语言召回以英文查询为可靠方向，中文查询召回英文条目能力有限。', languages: ['中文', 'English', '日本語', '多语言'],
      license: { name: 'MIT', url: 'https://huggingface.co/intfloat/multilingual-e5-small' }, runtime: 'onnx',
      architecture: 'BERT / multilingual E5 Small', dimensions: 384, maxTokens: 512, dtype: 'q8', pooling: 'mean', normalize: true,
      queryPrefix: 'query: ', passagePrefix: 'passage: ', minimumAppVersion: '0.16.3', recommendedMemoryMb: 650, installedSize: 140_461_234,
      files: [
        file(E5_REPO, E5_REVISION, 'config.json', 658, 'cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1'),
        file(E5_REPO, E5_REVISION, 'onnx/model_quantized.onnx', 118_308_185, 'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193'),
        file(E5_REPO, E5_REVISION, 'sentencepiece.bpe.model', 5_069_051, 'cfc8146abe2a0488e9e2a0c56de7952f7c11ab059eca145a0a727afce0db2865'),
        file(E5_REPO, E5_REVISION, 'special_tokens_map.json', 167, 'd05497f1da52c5e09554c0cd874037a083e1dc1b9cfd48034d1c717f1afc07a7'),
        file(E5_REPO, E5_REVISION, 'tokenizer.json', 17_082_730, '0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39'),
        file(E5_REPO, E5_REVISION, 'tokenizer_config.json', 443, 'a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b'),
      ],
      catalogSignature: '3GUy8PRPsasltUJTt5NbHnQ8GA3nqRTZOCTK/NBgkJtoDrsblK6pimS3OFOgZvHi1TfE+Pjgiq6c8pldc6tlDw==',
    },
  ],
  signature: 'ribVV9BHyL0meF9PrmZle6LN2cfQ1NlEeOW34N3sQWzwPzCkC3KFomeifznGrVUABPvmoUMpU1rvrSK2ihAdBQ==',
}
