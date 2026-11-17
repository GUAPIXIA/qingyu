/**
 * 朗读前文本清洗（2026-11-17）。
 *
 * 消息正文里可能夹带不可朗读的内容：markdown 图片、内嵌 `<audio>` / `<img>` 标签、
 * data: URI（base64 图片）、裸 URL、代码块。直接送去 TTS 会读出整段 URL/base64，
 * 既难听又可能触发接口体积/内容限制，因此朗读前统一剔除，只保留自然语言。
 *
 * 复用 `stripMarkdownNoise`（世界书扫描用的同一套 markdown 去噪），再补两类它不处理的：
 * - `data:` URI（可能几十 KB base64，且不一定包在 markdown 图片里）；
 * - 裸 `http(s)://` 链接（markdown 链接的文字仍保留）。
 */

import { stripMarkdownNoise } from '../../shared/chat-core/lorebook'

/** data: URI（含可选参数，如 data:image/png;base64,...） */
const DATA_URI = /data:[a-z0-9.+-]+\/[a-z0-9.+-]+(?:;[a-z0-9=+-]+)*;base64,[A-Za-z0-9+/=\s]+/gi

/** 裸 URL（排除中文标点与成对括号，避免吞掉后续正文） */
const BARE_URL = /https?:\/\/[^\s<>()"'，。！？；：、,]+/gi

/** 清洗为可朗读文本：剔除图片/音频/代码/链接等非朗读内容，压缩空白。 */
export function sanitizeTtsText(text: string): string {
  if (!text) return ''
  const stripped = stripMarkdownNoise(
    text
      .replace(DATA_URI, ' ')
      .replace(BARE_URL, ' '),
  )
  return stripped
    // 行内空白压缩（保留换行作为句界提示）；三行以上空行压成两行
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
