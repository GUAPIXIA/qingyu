/**
 * 下载文件工具函数
 * 将内容转换为 Blob 并触发浏览器下载
 */
export function downloadFile(content: string, filename: string, mimeType = 'text/markdown') {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
