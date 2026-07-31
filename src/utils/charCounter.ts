/**
 * 字符统计工具
 *
 * 精确统计文本中的中文字符、英文字符、数字及符号数量。
 * 不依赖任何 token 计算方式，直接按字符类别计数。
 */

export interface CharCountResult {
  /** 中文字符数（含 CJK 统一汉字、扩展A区、兼容汉字） */
  chinese: number
  /** 英文字母数 */
  english: number
  /** 数字字符数 */
  numbers: number
  /** 符号数（含标点、空格、换行、表情等所有非上述类别字符） */
  symbols: number
  /** 总字符数 */
  total: number
}

/** CJK 中文字符范围：基本汉字 + 扩展A + 兼容汉字 */
const CJK_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/
const ENGLISH_REGEX = /[a-zA-Z]/
const NUMBER_REGEX = /[0-9]/

/**
 * 统计文本中各类字符的数量
 *
 * 每个字符恰好归入一个类别（中文 / 英文 / 数字 / 符号），
 * total 为各类别之和，等于字符串长度。
 */
export function countChars(text: string): CharCountResult {
  if (!text) return { chinese: 0, english: 0, numbers: 0, symbols: 0, total: 0 }

  let chinese = 0
  let english = 0
  let numbers = 0
  let symbols = 0

  for (const char of text) {
    if (CJK_REGEX.test(char)) chinese++
    else if (ENGLISH_REGEX.test(char)) english++
    else if (NUMBER_REGEX.test(char)) numbers++
    else symbols++
  }

  return { chinese, english, numbers, symbols, total: chinese + english + numbers + symbols }
}

/** 格式化字符数，便于 UI 展示 */
export function formatCharCount(n: number): string {
  if (typeof n !== 'number' || isNaN(n)) return '0'
  if (n < 1000) return n.toString()
  if (n < 10000) return `${(n / 1000).toFixed(1)}K`
  return `${Math.round(n / 1000)}K`
}
