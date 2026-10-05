// UI 层适配器（方案 §3.1 adapters、§6 层级口径）。
// 动作在 catalog 中以声明式步骤描述（不写任意脚本、不注入 JS），这里按声明执行真实界面操作。
// 定位优先使用可访问名称/角色/标题；定位失败时返回候选清单，便于登记工具限制而不是猜。
//
// 支持的步骤 kind：
//   navigate  —— 点击侧栏导航项（role=link, name）
//   click     —— 点击元素（role/name 或 title）
//   fill      —— 在输入框填入文本（label/placeholder）
//   readText  —— 读取元素文本（用于 UI 层断言）
// 参数占位：字符串中的 {{0}}、{{1}} 会被位置参数替换。

export const UI_STEP_KINDS = ['navigate', 'goto', 'click', 'clickWithin', 'fill', 'readText', 'debugDump']

export function interpolate(template, args) {
  if (typeof template !== 'string') return template
  return template.replace(/\{\{(\d+)\}\}/g, (_, index) => {
    const value = args?.[Number(index)]
    return value === undefined || value === null ? '' : String(value)
  })
}

function locate(page, step, args) {
  // name 可能来自 name/title/placeholder/label/testId 中的任意一个
  const rawName = step.name ?? step.title ?? step.placeholder ?? step.label ?? step.testId ?? ''
  const name = interpolate(rawName, args)
  const options = {}
  if (step.exact) options.exact = true
  if (step.title) return page.getByTitle(name, options)
  if (step.placeholder) return page.getByPlaceholder(name, options)
  if (step.label) return page.getByLabel(name, options)
  if (step.testId) return page.getByTestId(name)
  const role = step.role ?? 'button'
  if (step.regex) return page.getByRole(role, { name: new RegExp(name) })
  // 注意：name 过滤必须显式带上，否则 exact 选项会让选择器退化成“该角色的第一个元素”
  return name ? page.getByRole(role, { name, ...options }) : page.getByRole(role, options)
}

/** 步骤作用域：带 frame 的步骤在 iframe 内定位（如嵌入的空间画板） */
function scopeFor(page, step) {
  if (!step.frame) return page
  return page.frameLocator(step.frame)
}

async function candidates(page, limit = 12) {
  try {
    const items = await page.locator('a, button, [role="button"], [role="link"], [role="tab"]').evaluateAll(
      (nodes, max) => nodes
        .map((node) => ({
          tag: node.tagName.toLowerCase(),
          text: (node.textContent ?? '').trim().slice(0, 40),
          title: node.getAttribute('title') ?? '',
          aria: node.getAttribute('aria-label') ?? '',
        }))
        .filter((item) => item.text || item.title || item.aria)
        .slice(0, max),
      limit,
    )
    return items
  } catch {
    return []
  }
}

async function runStep(page, step, args, context) {
  const timeout = step.timeoutMs ?? 15000
  switch (step.kind) {
    case 'navigate': {
      const locator = locate(page, { ...step, role: step.role ?? 'link' }, args)
      const element = locator.first()
      const href = await element.getAttribute('href').catch(() => null)
      await element.click({ timeout })
      const urlAfterClick = page.url()
      await page.waitForTimeout(step.settleMs ?? 300)
      return { kind: 'navigate', target: interpolate(step.name, args), href, urlAfterClick, url: page.url() }
    }
    case 'goto': {
      // 直接改 hash 路由：不依赖侧栏展开状态/可见性，比点击链接稳定（本应用为 hash 路由 SPA）
      const before = page.url()
      const target = interpolate(step.url, args)
      await page.evaluate((hash) => {
        const next = hash.startsWith('#') ? hash : `#${hash}`
        window.location.hash = next
      }, target)
      await page.waitForTimeout(step.settleMs ?? 500)
      return { kind: 'goto', target, urlBefore: before, url: page.url() }
    }
    case 'click': {
      const locator = locate(scopeFor(page, step), step, args)
      await locator.first().click({ timeout })
      await page.waitForTimeout(step.settleMs ?? 300)
      return { kind: 'click', target: interpolate(step.name ?? step.title, args), frame: step.frame ?? null }
    }
    case 'clickWithin': {
      // 在“包含指定文本、且内部存在目标控件”的最近祖先容器内点击。
      // 用 xpath 取最近祖先，避免用 div 泛匹配导致命中页面级容器而点到隐藏元素。
      const hasText = interpolate(step.hasText, args)
      const target = interpolate(step.name, args)
      const anchor = scopeFor(page, step).getByText(hasText, { exact: false }).first()
      await anchor.waitFor({ state: 'visible', timeout })
      // XPath 里不能把两条路径用逗号塞进同一个谓词，这里用 or 连接两个条件
      const escaped = String(target).replace(/"/g, '&quot;')
      const container = anchor.locator(
        `xpath=ancestor::*[.//button[@aria-label="${escaped}"] or .//*[@role="button"][@aria-label="${escaped}"]][1]`,
      )
      const locator = container.getByRole(step.role ?? 'button', { name: target })
      await locator.first().click({ timeout })
      await page.waitForTimeout(step.settleMs ?? 500)
      return { kind: 'clickWithin', hasText, target }
    }
    case 'fill': {
      const locator = locate(scopeFor(page, step), { ...step, role: step.role ?? 'textbox' }, args)
      await locator.first().fill(interpolate(step.value ?? '{{0}}', args), { timeout })
      return { kind: 'fill', target: interpolate(step.name, args) }
    }
    case 'readText': {      // body=true 时读取整个作用域（含 iframe）的可见文本
      const scope = scopeFor(page, step)
      const element = step.body ? scope.locator('body') : locate(scope, step, args).first()
      await element.waitFor({ state: 'visible', timeout })
      const text = step.attribute ? await element.getAttribute(step.attribute) : await element.innerText()
      context.readText = text
      return { kind: 'readText', target: interpolate(step.name ?? step.title ?? step.role ?? 'body', args), frame: step.frame ?? null, text: String(text ?? '').slice(0, 200) }
    }
    case 'debugDump': {
      // 诊断步骤：不点击、不读取业务内容，只报告页面结构与角色元素，便于定位 UI 动作失败原因
      const dump = await page.evaluate(() => {
        const collect = (selector, limit = 40) => Array.from(document.querySelectorAll(selector))
          .map((node) => ({
            tag: node.tagName.toLowerCase(),
            role: node.getAttribute('role') ?? null,
            text: (node.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40),
            title: node.getAttribute('title') ?? null,
            ariaCurrent: node.getAttribute('aria-current') ?? null,
            visible: Boolean(node.getBoundingClientRect().width && node.getBoundingClientRect().height),
          }))
          .slice(0, limit)
        return {
          url: window.location.href,
          menus: collect('[role="menu"]', 5),
          menuItems: collect('[role="menuitem"]', 20),
          buttons: collect('button, [role="button"]', 40),
        }
      })
      await page.waitForTimeout(step.settleMs ?? 200)
      context.debugDump = dump
      return { kind: 'debugDump', url: dump.url, dump }
    }
    default: {
      const error = new Error(`不支持的 UI 步骤：${step.kind}`)
      error.code = 'UI_STEP_UNSUPPORTED'
      throw error
    }
  }
}

/**
 * 执行一个 UI 动作：先跑 pre 步骤（如导航/打开面板），再跑主步骤。
 * 任一步失败时，把当前可见的候选元素一并抛出，便于定位与登记限制。
 */
export async function runUiAction(page, action, args) {
  const spec = action.ui
  if (!spec || !spec.kind) {
    const error = new Error(`UI 动作缺少 ui 声明：${action.id}`)
    error.code = 'UI_SPEC_MISSING'
    throw error
  }
  const context = { readText: null, steps: [] }
  const steps = [...(spec.pre ?? []), spec]
  try {
    for (const step of steps) context.steps.push(await runStep(page, step, args, context))
  } catch (error) {
    const seen = await candidates(page)
    const hint = seen.length
      ? `\n  当前可交互元素候选：${seen.map((item) => `${item.tag}[${item.aria || item.title || item.text}]`).join(' | ')}`
      : ''
    const wrapped = new Error(`${error.message.split('\n')[0]}${hint}`)
    wrapped.code = 'UI_LOCATOR_FAILED'
    wrapped.detail = { steps: context.steps, candidates: seen }
    throw wrapped
  }
  return { value: context.readText ?? null, steps: context.steps }
}

/** 校验 catalog 中的 ui 声明（门禁与自测共用） */
export function validateUiSpec(action) {
  const errors = []
  if (action.origin !== 'tool') return errors
  if (action.adapter !== 'ui') return errors
  const spec = action.ui
  if (!spec) {
    errors.push(`UI 动作缺少 ui 声明：${action.id}`)
    return errors
  }
  const all = [...(spec.pre ?? []), spec]
  for (const step of all) {
    if (!UI_STEP_KINDS.includes(step.kind)) errors.push(`UI 步骤 kind 非法：${action.id} → ${step.kind}`)
    if (step.frame !== undefined && typeof step.frame !== 'string') errors.push(`UI 步骤 frame 必须是字符串选择器：${action.id}`)
    const hasTarget = Boolean(step.name || step.title || step.placeholder || step.label || step.testId)
    if (step.kind === 'goto') {
      if (typeof step.url !== 'string' || !step.url) errors.push(`goto 步骤缺少 url（hash 路由，如 #/api）：${action.id}`)
      continue
    }
    if (step.kind === 'debugDump') continue // 诊断步骤：只读取页面结构，无需定位目标
    if (step.kind === 'clickWithin') {
      if (!step.hasText) errors.push(`clickWithin 步骤缺少 hasText：${action.id}`)
      if (!hasTarget) errors.push(`clickWithin 步骤缺少目标名称：${action.id}`)
    } else if (step.kind === 'readText') {
      // 允许只按 role 或 body 读取整块区域（如 main、iframe body）
      if (!hasTarget && !step.role && !step.body) errors.push(`readText 步骤既没有名称、role 也没有 body：${action.id}`)
    } else if (!hasTarget) {
      errors.push(`UI 步骤缺少定位信息（name/title/placeholder/label/testId）：${action.id} → ${step.kind}`)
    }
  }
  return errors
}
