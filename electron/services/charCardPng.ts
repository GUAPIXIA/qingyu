/**
 * PNG 二进制工具（角色卡导出/导入共用，P-8 从 charCard.ts 拆分）
 * - tEXt/iTXt chunk 读写（角色卡数据嵌入 PNG 文本段）
 * - IEND 定位与 CRC32（写入文本 chunk 需重算校验）
 * - 图片 MIME 嗅探（封面下载返回的二进制识别类型）
 */

/** PNG 签名 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** 检测图片类型并返回正确的 MIME */
export function detectMimeType(buffer: Buffer): string {
  // PNG
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return 'image/png'
  }
  // JPEG: FF D8 FF
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg'
  }
  // GIF: 47 49 46 38
  if (buffer.length >= 6 && buffer.subarray(0, 4).toString('ascii') === 'GIF8') {
    return 'image/gif'
  }
  // WebP: 52 49 46 46 ... 57 45 42 50
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp'
  }
  return 'image/png' // 默认
}

/** PNG tEXt chunk 读取 */
export function readPngTextChunks(buffer: Buffer): Record<string, string> {
  const chunks: Record<string, string> = {}
  // PNG 签名校验：必须用 Buffer.equals，不能用 toString('ascii')
  // 因为 toString('ascii') 会把 0x89 截断为 0x09，导致签名永远不匹配
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return chunks
  }
  let offset = 8
  while (offset < buffer.length) {
    // 边界检查：chunk 头（长度 4B + 类型 4B）或数据区越界时中止，防止损坏 PNG 引发内存问题
    if (offset + 8 > buffer.length) break
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const dataStart = offset + 8
    if (dataStart + length > buffer.length) break
    const data = buffer.subarray(dataStart, dataStart + length)
    if (type === 'tEXt') {
      const nullIdx = data.indexOf(0)
      if (nullIdx > 0) {
        const key = data.toString('ascii', 0, nullIdx)
        const value = data.toString('utf-8', nullIdx + 1)
        chunks[key] = value
      }
    } else if (type === 'iTXt') {
      // iTXt 格式: keyword\0  compression_flag(1)  compression_method(1)  language\0  translated\0  text
      const nullIdx = data.indexOf(0)
      if (nullIdx > 0) {
        const key = data.toString('ascii', 0, nullIdx)
        // 跳过 compression_flag(1) + compression_method(1)
        let pos = nullIdx + 3
        const langEnd = data.indexOf(0, pos)
        if (langEnd < 0) continue
        pos = langEnd + 1
        const transEnd = data.indexOf(0, pos)
        if (transEnd < 0) continue
        const textStart = transEnd + 1
        if (textStart < data.length) {
          const value = data.toString('utf-8', textStart)
          chunks[key] = value
        }
      }
    } else if (type === 'IEND') {
      break
    }
    offset = dataStart + length + 4
  }
  return chunks
}

/** 向 PNG 写入 tEXt chunk */
export function writePngTextChunk(buffer: Buffer, key: string, value: string): Buffer {
  const keyBytes = Buffer.from(key, 'ascii')
  const valueBytes = Buffer.from(value, 'utf-8')
  const nullByte = Buffer.from([0])
  const chunkData = Buffer.concat([keyBytes, nullByte, valueBytes])
  const typeBytes = Buffer.from('tEXt', 'ascii')
  const lengthBytes = Buffer.alloc(4)
  lengthBytes.writeUInt32BE(chunkData.length, 0)

  const crcData = Buffer.concat([typeBytes, chunkData])
  const crc = crc32(crcData)
  const crcBytes = Buffer.alloc(4)
  crcBytes.writeUInt32BE(crc >>> 0, 0)

  const iendOffset = findIENDOffset(buffer)
  if (iendOffset < 0) return buffer
  const before = buffer.subarray(0, iendOffset)
  const after = buffer.subarray(iendOffset)
  return Buffer.concat([before, lengthBytes, typeBytes, chunkData, crcBytes, after])
}

function findIENDOffset(buffer: Buffer): number {
  for (let i = buffer.length - 12; i >= 8; i--) {
    if (buffer.toString('ascii', i + 4, i + 8) === 'IEND') {
      return i
    }
  }
  return -1
}

const crcTable: number[] = []
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  crcTable[n] = c
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  }
  return crc ^ 0xffffffff
}
