/**
 * 轻量 HTML 消毒（纵深防御层）
 *
 * 公告内容允许 Markdown 内嵌 HTML，但不可信 HTML 可能携带
 * <script>、事件属性（onerror 等）或危险协议（javascript: 等）。
 * 策略：白名单标签 + 黑名单属性/协议，杀伤性过滤。
 *
 * 注意：这是服务端防御层；客户端渲染端已不启用 rehypeRaw（原始 HTML 不渲染），
 * 即使过滤存在极边缘绕过，危害也被渲染端兜底。
 */

/** 允许保留的标签白名单 */
const ALLOWED_TAGS = new Set([
  'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'ins', 'mark',
  'small', 'sub', 'sup', 'code', 'pre', 'kbd', 'blockquote', 'p',
  'br', 'hr', 'div', 'span', 'center',
  'a', 'img', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tfoot',
  'tr', 'th', 'td', 'caption', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'details', 'summary', 'figure', 'figcaption',
])

/** 允许保留的属性白名单（全局） */
const ALLOWED_ATTRS = new Set([
  'href', 'src', 'alt', 'title', 'class', 'id',
  'colspan', 'rowspan', 'width', 'height', 'align', 'start', 'rel',
])

/** 危险协议前缀（href/src 属性值中禁止） */
const DANGEROUS_PROTOCOLS = /^(javascript|vbscript|data|file|blob|about|chrome|chrome-extension):/i

/** 转义属性值（防引号逃逸与标签注入） */
function escapeAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** 属性级过滤：事件属性 / 危险协议 / 白名单外属性一律移除 */
function sanitizeAttr(name, value) {
  const n = name.toLowerCase()
  if (n.startsWith('on')) return null // 事件属性（onclick/onerror/onload...）一律移除
  if (!ALLOWED_ATTRS.has(n)) return null
  const v = String(value ?? '').trim()
  if (!v) return null
  if (n === 'href' || n === 'src') {
    if (DANGEROUS_PROTOCOLS.test(v)) return null
    // 仅允许 http/https 或相对路径
    if (!/^https?:\/\//i.test(v) && !v.startsWith('/') && !v.startsWith('./') && !v.startsWith('../')) {
      return null
    }
  }
  return `${n}="${escapeAttr(v)}"`
}

/** 重建单个标签：白名单外标签剥离（保留内容），属性过滤后重建 */
function rebuildTag(fullTag, tagName, attrsStr) {
  const tag = tagName.toLowerCase()
  if (!ALLOWED_TAGS.has(tag)) return '' // 白名单外标签：剥标签留内容
  if (fullTag.startsWith('</')) return `</${tag}>`

  const kept = []
  const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
  let m
  while ((m = attrRe.exec(attrsStr)) !== null) {
    const val = m[2] ?? m[3] ?? m[4] ?? ''
    const safe = sanitizeAttr(m[1], val)
    if (safe) kept.push(safe)
  }
  return `<${tag}${kept.length > 0 ? ' ' + kept.join(' ') : ''}>`
}

/** 消毒 HTML 字符串（非字符串输入返回空字符串） */
function sanitizeHtml(input) {
  if (typeof input !== 'string') return ''
  let out = input
    // 移除注释与 doctype
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!doctype[^>]*>/gi, '')
    // 危险容器块（含内容整体剥离）：script / style / iframe / object / embed / link / meta / base / form 等
    .replace(/<(script|style|iframe|object|embed|link|meta|base|form|input|button|textarea|select|option|video|audio|source|track|svg|math|template|noscript|frame|frameset|applet|param|title)[\s>][\s\S]*?<\/\1\s*>/gi, '')
    // 自闭合危险标签
    .replace(/<(iframe|object|embed|link|meta|base|input|source|track|svg|frame|applet|param)\b[^>]*\/?>/gi, '')

  // 逐标签重建（白名单 + 属性过滤）
  // H-18 修复：属性分隔从 \s+ 放宽为 [\s/]+——HTML 规范中 / 等价于空白，
  // 否则 <img/src=x/onerror=alert(1)> 这类写法整标签不匹配，原样留在输出（onerror 未过滤）。
  out = out.replace(
    /<\/?([a-zA-Z][a-zA-Z0-9]*)((?:[\s/]+(?:[a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g,
    (full, tagName, attrsStr) => rebuildTag(full, tagName, attrsStr)
  )
  return out
}

module.exports = { sanitizeHtml }
