/**
 * 朗读文本分句（2026-11-16，DeepSeek TTS 接入）。
 *
 * DeepSeek TTS 返回未压缩 wav（24 kHz 16-bit 单声道约 48 KB/s），整段合成有两个问题：
 * 长回复首包慢、单条消息的 base64 音频可达数十 MB。因此消息朗读改为逐句合成、边合成边播，
 * 这里负责把正文切成适合单次请求的片段。
 *
 * 切分规则：
 * - 在中文句末标点、换行处断句（英文句点不参与，避免 `Mr.` 之类误切）；
 * - 短句合并到同一片段，避免一问一请求；
 * - 单句超过上限时硬切，保证任何片段都不超过 `maxLen`。
 */

/** 默认单个朗读片段的最大字符数（约 40 秒语音，wav 约 1.9 MB） */
export const DEFAULT_TTS_CHUNK_LEN = 180

const SENTENCE_END = /(?<=[。！？!?；;…\n])/

/** 把待朗读正文切成朗读片段；空文本返回空数组。 */
export function splitTtsChunks(text: string, maxLen: number = DEFAULT_TTS_CHUNK_LEN): string[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  if (maxLen <= 0) return [trimmed]

  const units = trimmed.split(SENTENCE_END).map((unit) => unit.trim()).filter(Boolean)
  const chunks: string[] = []
  let current = ''
  const flush = (): void => {
    if (!current) return
    chunks.push(current)
    current = ''
  }

  for (const unit of units) {
    // 超长单句（无标点的长段落）先冲刷已积累片段，再硬切
    if (unit.length > maxLen) {
      flush()
      for (let i = 0; i < unit.length; i += maxLen) chunks.push(unit.slice(i, i + maxLen))
      continue
    }
    if (current.length + unit.length > maxLen) flush()
    current += unit
  }
  flush()
  return chunks
}
