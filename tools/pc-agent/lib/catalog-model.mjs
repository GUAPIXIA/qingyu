// 动作目录的装载、校验与渲染。目录是外部 Agent 看到的唯一真源，
// 能力矩阵由本模块渲染生成（不手写），门禁按同一套规则校验。
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONTRACT_ENTRY, REPO_ROOT } from './ipc-contract.mjs'
import { validateUiSpec } from './ui-adapter.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

export const CATALOG_DIR = resolve(HERE, '..', 'catalog')
export const EXCLUSIONS_PATH = resolve(HERE, '..', 'catalog.exclusions.json')
export const MATRIX_PATH = resolve(REPO_ROOT, 'docs', 'pc-agent', '能力矩阵.md')

/** 动作登记状态：骨架 → 待环境验证 → 已登记；豁免不写在目录里，写在 exclusions.json */
export const STATUSES = ['unregistered', 'pending', 'mapped']
/** 执行层级，与方案 §6 一致 */
export const LAYERS = ['mock', 'service', 'ipc', 'ui']
/** 工具来源动作可用的适配器（非 window.api 路径的动作） */
export const ADAPTERS = ['ui']
/** 动作来源：contract = 映射 window.api 成员；tool = 工具自定义动作（如 UI 操作） */
export const ORIGINS = ['contract', 'tool']

export function defaultActionId(namespace, name) {
  return `${namespace}.${name}`
}

export function readJson(absPath) {
  return JSON.parse(readFileSync(absPath, 'utf8'))
}

export function loadExclusions(path = EXCLUSIONS_PATH) {
  if (!existsSync(path)) return { version: 1, note: '', entries: [] }
  const doc = readJson(path)
  return {
    version: doc.version ?? 1,
    note: doc.note ?? '',
    entries: Array.isArray(doc.entries) ? doc.entries : [],
  }
}

/** 为目录文档建立 apiPath / id 索引。 */
export function indexDocs(docs) {
  const byApiPath = new Map()
  const byId = new Map()
  for (const doc of docs) {
    for (const action of doc.actions ?? []) {
      byApiPath.set(action.apiPath, { doc, action })
      if (action.id) byId.set(action.id, { doc, action })
    }
  }
  return { byApiPath, byId }
}

/** 读取 catalog/*.json；返回按命名空间排序的文档列表与 apiPath 索引。 */
export function loadCatalog(dir = CATALOG_DIR) {
  if (!existsSync(dir)) return { docs: [], byApiPath: new Map(), byId: new Map() }
  const files = readdirSync(dir).filter((name) => name.endsWith('.json')).sort()
  const docs = files.map((name) => ({ file: name, ...readJson(resolve(dir, name)) }))
  return { docs, ...indexDocs(docs) }
}

/** 由契约生成骨架文档（不写盘）。已存在的人类登记字段由 mergeCatalog 保留。 */
export function buildSkeleton(contract) {
  return contract.namespaces.map((ns) => ({
    namespace: ns.namespace,
    apiInterface: ns.apiInterface,
    apiPathPrefix: ns.apiPathPrefix,
    sourceFile: ns.sourceFile,
    note: '骨架由 catalog.generate.mjs 生成；status=unregistered 表示尚未登记为动作，阶段 3 逐批补全。不要手改 signature/params，改契约后重新生成。',
    actions: ns.members.map((member) => ({
      id: defaultActionId(ns.namespace, member.name),
      apiPath: member.apiPath,
      origin: 'contract',
      kind: member.kind,
      status: 'unregistered',
      signature: member.signature,
      params: member.params,
      returns: member.returns,
      description: '',
      layer: null,
      write: false,
      requires: [],
      redactKeys: [],
      awaitTask: null,
      control: false,
      dialog: null,
      modes: [],
      targetRef: null,
      preconditions: [],
      sideEffect: null,
      cancelable: null,
      waitFor: null,
      assertions: [],
      evidence: [],
    })),
  }))
}

/**
 * 把手写登记合并进骨架：保留已填字段，补新增成员的骨架，报告契约中已消失的登记。
 * 默认不删除悬空登记（避免抹掉人工成果），由调用方决定是否 --prune。
 */
export function mergeCatalog(skeleton, existing) {
  const existingByPath = new Map()
  for (const doc of existing.docs ?? []) {
    for (const action of doc.actions ?? []) existingByPath.set(action.apiPath ?? action.id, { doc, action })
  }

  const nextPaths = new Set()
  const merged = skeleton.map((doc) => ({
    ...doc,
    actions: doc.actions.map((action) => {
      nextPaths.add(action.apiPath ?? action.id)
      const previous = existingByPath.get(action.apiPath)?.action
      if (!previous) return action
      return {
        ...action,
        id: previous.id ?? action.id,
        status: STATUSES.includes(previous.status) ? previous.status : action.status,
        description: previous.description ?? '',
        layer: previous.layer ?? null,
        modes: previous.modes ?? [],
        targetRef: previous.targetRef ?? null,
        preconditions: previous.preconditions ?? [],
        sideEffect: previous.sideEffect ?? null,
        cancelable: previous.cancelable ?? null,
        // write 由人工登记（读/写分类是授权依据），生成时不得丢失
        write: previous.write ?? action.write ?? false,
        requires: previous.requires ?? [],
        redactKeys: previous.redactKeys ?? [],
        awaitTask: previous.awaitTask ?? null,
        control: previous.control ?? false,
        dialog: previous.dialog ?? null,
        pendingReason: previous.pendingReason ?? null,
        waitFor: previous.waitFor ?? null,
        assertions: previous.assertions ?? [],
        evidence: previous.evidence ?? [],
      }
    }),
  }))

  // 非契约来源（工具动作，如 UI 操作）整份保留，不参与契约骨架合并
  const skeletonNamespaces = new Set(skeleton.map((doc) => doc.namespace))
  const extraDocs = (existing.docs ?? []).filter((doc) => !skeletonNamespaces.has(doc.namespace))
  for (const doc of extraDocs) {
    for (const action of doc.actions ?? []) nextPaths.add(action.apiPath ?? action.id)
  }
  const docs = [...merged, ...extraDocs]

  const dropped = []
  for (const [apiPath, { doc, action }] of existingByPath) {
    if (!nextPaths.has(apiPath)) dropped.push({ namespace: doc.namespace, apiPath, id: action.id, status: action.status })
  }
  return { docs, dropped }
}

/**
 * 校验目录、豁免与能力矩阵。
 * errors 为致命项（门禁非零退出）；warnings 仅提示。
 */
export function validateCatalog({ contract, catalog, exclusions, matrixText, requireCovered = false }) {
  const errors = []
  const warnings = []

  const contractByPath = new Map()
  for (const ns of contract.namespaces) {
    for (const member of ns.members) contractByPath.set(member.apiPath, { ns, member })
  }

  const excludedByPath = new Map()
  for (const entry of exclusions.entries) {
    if (!entry.apiPath) {
      errors.push(`豁免条目缺少 apiPath：${JSON.stringify(entry)}`)
      continue
    }
    if (!entry.reason || !String(entry.reason).trim()) {
      errors.push(`豁免条目缺少 reason，豁免必须说明原因：${entry.apiPath}`)
    }
    if (!contractByPath.has(entry.apiPath)) {
      errors.push(`豁免条目指向的接口已不存在（悬空豁免）：${entry.apiPath}`)
    }
    excludedByPath.set(entry.apiPath, entry)
  }

  const seenIds = new Map()
  const seenPaths = new Set()
  const toolDocs = []
  for (const doc of catalog.docs) {
    const ns = contract.namespaces.find((item) => item.namespace === doc.namespace)
    if (!ns) {
      // 非契约来源：必须是工具动作（origin=tool + 已知 adapter），否则视为写错的命名空间
      const allTool = (doc.actions ?? []).every((action) => action.origin === 'tool')
      if (!allTool) {
        errors.push(`目录文件 ${doc.file} 的命名空间不在契约中，且含非工具动作：${doc.namespace}`)
        continue
      }
      toolDocs.push(doc)
      for (const action of doc.actions ?? []) {
        validateActionCommon(action, { errors, warnings, seenIds, seenPaths })
        if (!ADAPTERS.includes(action.adapter)) {
          errors.push(`工具动作的 adapter 非法：${action.id} → ${action.adapter}，允许值 ${ADAPTERS.join(' / ')}`)
        }
        if (action.status === 'pending' && !String(action.pendingReason ?? '').trim()) {
          errors.push(`状态为 pending 的动作必须写明 pendingReason：${action.id}`)
        }
        if (action.status === 'mapped') {
          if (!action.description || !String(action.description).trim()) errors.push(`已登记动作缺少 description：${action.id}`)
          if (!LAYERS.includes(action.layer)) errors.push(`已登记动作的 layer 非法：${action.id} → ${action.layer}`)
        }
      }
      continue
    }
    if (doc.apiInterface !== ns.apiInterface) {
      errors.push(`目录文件 ${doc.file} 的 apiInterface 与契约不一致：${doc.apiInterface} ≠ ${ns.apiInterface}`)
    }
    if (doc.apiPathPrefix !== ns.apiPathPrefix) {
      errors.push(`目录文件 ${doc.file} 的 apiPathPrefix 与契约不一致：${doc.apiPathPrefix} ≠ ${ns.apiPathPrefix}`)
    }

    for (const action of doc.actions ?? []) {
      validateActionCommon(action, { errors, warnings, seenIds, seenPaths })

      if (action.origin === 'tool') {
        errors.push(`契约命名空间下的动作不能是工具来源：${action.id}`)
      }
      if (action.status === 'pending' && !String(action.pendingReason ?? '').trim()) {
        errors.push(`状态为 pending 的动作必须写明 pendingReason：${action.id}（需要模型/网络/原生对话框等环境）`)
      }

      const contractMember = contractByPath.get(action.apiPath)
      if (!contractMember) {
        errors.push(`悬空映射：catalog 中的 ${action.apiPath} 已不在契约中，请重新生成目录或删除该登记`)
        continue
      }
      if (action.signature !== contractMember.member.signature) {
        errors.push(
          `签名漂移：${action.apiPath}\n    catalog: ${action.signature}\n    契约  : ${contractMember.member.signature}\n    处理：运行 pnpm pc-agent:catalog 重新生成`,
        )
      }
      if (action.status === 'mapped') {
        if (!action.description || !String(action.description).trim()) {
          errors.push(`已登记动作缺少 description：${action.apiPath}`)
        }
        if (!LAYERS.includes(action.layer)) {
          errors.push(`已登记动作的 layer 非法：${action.apiPath} → ${action.layer}，允许值 ${LAYERS.join(' / ')}`)
        }
      }
    }
  }

  const coverage = { total: contract.memberCount, mapped: 0, pending: 0, unregistered: 0, excluded: 0, missing: 0, toolActions: 0 }
  const perNamespace = []
  for (const ns of contract.namespaces) {
    const row = { namespace: ns.namespace, apiInterface: ns.apiInterface, sourceFile: ns.sourceFile, total: ns.members.length, mapped: 0, pending: 0, unregistered: 0, excluded: 0, missing: 0 }
    for (const member of ns.members) {
      const excluded = excludedByPath.has(member.apiPath)
      const entry = catalog.byApiPath.get(member.apiPath)
      if (excluded) row.excluded += 1
      else if (!entry) {
        row.missing += 1
        errors.push(`契约成员既未登记也未豁免：${member.apiPath}（${ns.apiInterface}.${member.name}）`)
      } else if (entry.action.status === 'mapped') row.mapped += 1
      else if (entry.action.status === 'pending') row.pending += 1
      else row.unregistered += 1
    }
    coverage.mapped += row.mapped
    coverage.pending += row.pending
    coverage.unregistered += row.unregistered
    coverage.excluded += row.excluded
    coverage.missing += row.missing
    perNamespace.push(row)
  }
  coverage.toolActions = toolDocs.reduce((sum, doc) => sum + (doc.actions ?? []).length, 0)

  if (matrixText !== undefined) {
    const expected = renderMatrix({ contract, catalog, exclusions })
    if (matrixText !== expected) {
      errors.push(`能力矩阵与 catalog 渲染结果不一致（陈旧）：${relativeFromRoot(MATRIX_PATH)}\n    处理：运行 pnpm pc-agent:catalog 重新生成`)
    }
  }

  if (requireCovered && coverage.unregistered > 0) {
    errors.push(`--require-covered：仍有 ${coverage.unregistered} 个契约成员处于 unregistered，未达到覆盖要求`)
  }

  return { errors, warnings, coverage, perNamespace, toolDocs }
}

/** 动作通用校验（契约来源与工具来源共用） */
function validateActionCommon(action, { errors, warnings, seenIds, seenPaths }) {
  const key = action.apiPath ?? action.id
  if (seenPaths.has(key)) errors.push(`动作重复登记：${key}`)
  seenPaths.add(key)

  if (action.id) {
    const owner = seenIds.get(action.id)
    if (owner) errors.push(`动作 id 重复：${action.id}（${owner} 与 ${key}）`)
    else seenIds.set(action.id, key)
    if (!/^[a-z][A-Za-z0-9]*\.[A-Za-z0-9._-]+$/.test(action.id)) {
      warnings.push(`动作 id 命名不规范（建议 <模块>.<动作>）：${action.id}`)
    }
  } else {
    errors.push(`动作缺少 id：${key}`)
  }

  if (!STATUSES.includes(action.status)) {
    errors.push(`动作状态非法（${key}）：${action.status}，允许值 ${STATUSES.join(' / ')}`)
  }
  if (action.origin && !ORIGINS.includes(action.origin)) {
    errors.push(`动作来源非法（${key}）：${action.origin}，允许值 ${ORIGINS.join(' / ')}`)
  }
  if (action.redactKeys !== undefined && !Array.isArray(action.redactKeys)) {
    errors.push(`redactKeys 必须是数组：${key}`)
  }
  if (action.requires !== undefined && !Array.isArray(action.requires)) {
    errors.push(`requires 必须是数组：${key}`)
  }
  if (action.awaitTask !== undefined && action.awaitTask !== null) {
    if (typeof action.awaitTask !== 'object') errors.push(`awaitTask 必须是对象或 null：${key}`)
    else {
      if (action.awaitTask.path !== undefined && typeof action.awaitTask.path !== 'string') {
        errors.push(`awaitTask.path 必须是字符串：${key}`)
      }
      if (action.awaitTask.poll !== undefined && typeof action.awaitTask.poll !== 'string') {
        errors.push(`awaitTask.poll 必须是接口路径字符串：${key}`)
      }
      if (action.awaitTask.timeoutMs !== undefined && !(Number(action.awaitTask.timeoutMs) > 0)) {
        errors.push(`awaitTask.timeoutMs 必须是正数：${key}`)
      }
    }
  }
  if (action.control !== undefined && typeof action.control !== 'boolean') {
    errors.push(`control 必须是布尔值：${key}`)
  }
  if (action.dialog !== undefined && action.dialog !== null) {
    if (typeof action.dialog !== 'object') errors.push(`dialog 必须是对象或 null：${key}`)
    else {
      if (!['save', 'open'].includes(action.dialog.kind)) errors.push(`dialog.kind 必须是 save 或 open：${key}`)
      if (action.dialog.pathTemplate !== undefined && action.dialog.pathTemplate !== null && typeof action.dialog.pathTemplate !== 'string') {
        errors.push(`dialog.pathTemplate 必须是字符串或 null：${key}`)
      }
    }
  }
  for (const message of validateUiSpec(action)) errors.push(message)
}

function relativeFromRoot(absPath) {
  return absPath.startsWith(REPO_ROOT) ? absPath.slice(REPO_ROOT.length + 1).replace(/\\/g, '/') : absPath
}

function cell(value) {
  return value === null || value === undefined || value === '' ? '-' : String(value).replace(/\|/g, '\\|')
}

/** 渲染能力矩阵（确定性输出：不写入时间戳，随契约哈希变化）。 */
export function renderMatrix({ contract, catalog, exclusions }) {
  const excludedByPath = new Map(exclusions.entries.map((entry) => [entry.apiPath, entry]))
  const rows = []
  for (const ns of contract.namespaces) {
    for (const member of ns.members) {
      const entry = catalog.byApiPath.get(member.apiPath)
      const excluded = excludedByPath.get(member.apiPath)
      const action = entry?.action
      rows.push({
        namespace: ns.namespace,
        id: excluded ? member.name : action?.id ?? member.name,
        apiPath: member.apiPath,
        kind: member.kind,
        status: excluded ? 'excluded' : action?.status ?? 'missing',
        layer: action?.layer ?? null,
        description: excluded ? excluded.reason : action?.description ?? (action?.pendingReason ? `待环境：${action.pendingReason}` : ''),
        write: action?.write === true,
        requires: (action?.requires ?? []).join(','),
        async: Boolean(action?.awaitTask),
      })
    }
  }

  const { coverage, perNamespace } = validateCoverageOnly({ contract, catalog, exclusions })
  const toolDocs = (catalog.docs ?? []).filter((doc) => !contract.namespaces.some((ns) => ns.namespace === doc.namespace))

  const lines = []
  lines.push('# PC 端外部 Agent 能力矩阵')
  lines.push('')
  lines.push('> **本文件由 `tools/pc-agent/catalog.generate.mjs` 从动作目录渲染生成，请勿手改。**')
  lines.push(`> 契约：\`${contract.contractPath}\`（哈希 \`${contract.contractHash}\`）· 命名空间 ${contract.namespaces.length} · 契约成员 ${contract.memberCount}`)
  lines.push('> 状态口径：`mapped` 已登记为可执行；`pending` 已确认登记但需模型/网络/原生对话框等环境才能验证（原因见说明列）；`unregistered` 尚未处理；`excluded` 已豁免（见 `tools/pc-agent/catalog.exclusions.json`）。')
  lines.push('> 层级口径：`ipc` 走正式 preload 调用；`ui` 操作真实界面控件；两者结论不可互相替代（方案 §6）。')
  lines.push('> 覆盖口径：只有 `source-isolated` 模式的结论可声明“全端覆盖”（方案 v2 §7）；其它模式只要求标注准确。')
  lines.push('')
  lines.push('## 1. 总览')
  lines.push('')
  lines.push('| 模块 | 接口 | 定义位置 | 契约成员 | mapped | pending | unregistered | excluded |')
  lines.push('|---|---|---|---:|---:|---:|---:|---:|')
  for (const row of perNamespace) {
    lines.push(`| ${row.namespace} | ${cell(row.apiInterface)} | \`${row.sourceFile}\` | ${row.total} | ${row.mapped} | ${row.pending} | ${row.unregistered} | ${row.excluded} |`)
  }
  lines.push(`| **合计** | | | **${coverage.total}** | **${coverage.mapped}** | **${coverage.pending}** | **${coverage.unregistered}** | **${coverage.excluded}** |`)
  lines.push('')
  lines.push('## 2. 明细')
  for (const ns of contract.namespaces) {
    lines.push('')
    lines.push(`### ${ns.namespace}（${cell(ns.apiInterface)}）`)
    lines.push('')
    lines.push('| 动作 id | API 路径 | 类型 | 状态 | 层级 | 写 | 异步 | 环境要求 | 说明 |')
    lines.push('|---|---|---|---|---|---|---|---|---|')
    for (const row of rows.filter((item) => item.namespace === ns.namespace)) {
      lines.push(`| ${cell(row.id)} | \`${row.apiPath}\` | ${row.kind} | ${row.status} | ${cell(row.layer)} | ${row.write ? '写' : '读'} | ${row.async ? '异步' : '-'} | ${cell(row.requires)} | ${cell(row.description)} |`)
    }
  }
  if (toolDocs.length > 0) {
    lines.push('')
    lines.push('## 3. 工具动作（非契约来源）')
    lines.push('')
    lines.push('> 这些动作不对应 `window.api` 成员，由工具自身的适配器执行（当前为 UI 层操作）。')
    lines.push('')
    lines.push('| 动作 id | 适配器 | 状态 | 层级 | 写 | 说明 |')
    lines.push('|---|---|---|---|---|---|')
    for (const doc of toolDocs) {
      for (const action of doc.actions ?? []) {
        lines.push(`| ${cell(action.id)} | ${cell(action.adapter)} | ${action.status} | ${cell(action.layer)} | ${action.write ? '写' : '读'} | ${cell(action.description)} |`)
      }
    }
  }
  lines.push('')
  return lines.join('\n')
}

/** 只算覆盖统计，不做校验（渲染路径使用，避免递归依赖） */
function validateCoverageOnly({ contract, catalog, exclusions }) {
  const excludedByPath = new Set(exclusions.entries.map((entry) => entry.apiPath))
  const coverage = { total: contract.memberCount, mapped: 0, pending: 0, unregistered: 0, excluded: 0, missing: 0 }
  const perNamespace = []
  for (const ns of contract.namespaces) {
    const row = { namespace: ns.namespace, apiInterface: ns.apiInterface, sourceFile: ns.sourceFile, total: ns.members.length, mapped: 0, pending: 0, unregistered: 0, excluded: 0, missing: 0 }
    for (const member of ns.members) {
      if (excludedByPath.has(member.apiPath)) row.excluded += 1
      else {
        const entry = catalog.byApiPath.get(member.apiPath)
        if (!entry) row.missing += 1
        else if (entry.action.status === 'mapped') row.mapped += 1
        else if (entry.action.status === 'pending') row.pending += 1
        else row.unregistered += 1
      }
    }
    coverage.mapped += row.mapped
    coverage.pending += row.pending
    coverage.unregistered += row.unregistered
    coverage.excluded += row.excluded
    coverage.missing += row.missing
    perNamespace.push(row)
  }
  return { coverage, perNamespace }
}

export { CONTRACT_ENTRY, REPO_ROOT }


