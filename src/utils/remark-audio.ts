/**
 * remark 插件：消息内嵌 HTML `<audio src="..." controls loop>` → 可渲染 audio 节点。
 *
 * 背景：react-markdown 默认不渲染原始 HTML（rehypeRaw 已因 XSS 禁用），
 * `<audio>` 标签会显示为转义文本。本插件白名单提取 http(s) 音频 URL，
 * 转换为自定义 hast 节点（hName='audio'），由 markdownComponents.audio 渲染播放器。
 * 不执行任意 HTML，仅接受显式 `<audio src="http(s)://...">` 形态。
 */
interface AudioNode {
  type: string
  value?: string
  url?: string
  data?: {
    hName: string
    hProperties: Record<string, unknown>
  }
  children?: AudioNode[]
}

export function remarkAudio() {
  return (tree: AudioNode) => {
    walk(tree, (node: AudioNode) => {
      if (node.type !== 'html' || typeof node.value !== 'string') return
      const m = node.value.match(/<audio\s+[^>]*src\s*=\s*["']([^"']+)["'][^>]*>/i)
      if (!m) return
      const url = m[1]
      if (!/^https?:\/\//i.test(url)) return
      node.type = 'audio'
      node.url = url
      node.data = {
        hName: 'audio',
        hProperties: {
          src: url,
          controls: true,
          loop: /loop/i.test(node.value),
        },
      }
      delete node.value
    })
  }
}

function walk(node: AudioNode, fn: (node: AudioNode) => void): void {
  fn(node)
  if (Array.isArray(node?.children)) {
    for (const child of node.children) walk(child, fn)
  }
}
