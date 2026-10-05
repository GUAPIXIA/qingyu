// 从产品契约（shared/ipc-api.ts）解析可外部调用的接口面：命名空间 → 接口 → 成员。
// 只做结构解析（TypeScript AST），不做类型检查；不修改也不依赖产品实现。
// 跨文件接口（如 ExposedAPI.localModel → shared/localModels.ts）按相对导入解析。
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 仓库根（tools/pc-agent/lib → 上溯三级） */
export const REPO_ROOT = resolve(HERE, '..', '..', '..')
/** 契约入口，相对仓库根 */
export const CONTRACT_ENTRY = 'shared/ipc-api.ts'
/** 契约的全局挂载点（preload 暴露的 window.api） */
export const API_GLOBAL = 'window.api'

const fileCache = new Map()

function normalize(text) {
  return String(text).replace(/\s+/g, ' ').trim()
}

function parseFile(absPath) {
  const cached = fileCache.get(absPath)
  if (cached) return cached

  const text = readFileSync(absPath, 'utf8')
  const source = ts.createSourceFile(absPath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

  /** 本文件内的接口/类型声明 */
  const declarations = new Map()
  /** 本文件的相对导入：本地名 → 模块说明符 */
  const imports = new Map()

  for (const statement of source.statements) {
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
      declarations.set(statement.name.text, statement)
      continue
    }
    if (ts.isImportDeclaration(statement) && statement.importClause) {
      const specifier = statement.moduleSpecifier
      if (!ts.isStringLiteral(specifier) || !specifier.text.startsWith('.')) continue
      const clause = statement.importClause
      const bindings = clause.namedBindings
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          imports.set(element.name.text, specifier.text)
        }
      }
    }
  }

  const parsed = { absPath, source, declarations, imports }
  fileCache.set(absPath, parsed)
  return parsed
}

function resolveModuleFile(fromAbsPath, specifier) {
  const base = resolve(dirname(fromAbsPath), specifier)
  const candidates = [base, `${base}.ts`, `${base}.tsx`, resolve(base, 'index.ts')]
  for (const candidate of candidates) {
    try {
      readFileSync(candidate)
      return candidate
    } catch {
      // 继续尝试下一个候选
    }
  }
  return null
}

/** 解析类型引用指向的接口声明；解析不到返回 null（由调用方登记为未解析）。 */
function resolveInterfaceDeclaration(typeName, fromParsed) {
  const local = fromParsed.declarations.get(typeName)
  if (local && ts.isInterfaceDeclaration(local)) return { node: local, parsed: fromParsed }
  if (local && ts.isTypeAliasDeclaration(local)) {
    const type = local.type
    if (type && ts.isTypeLiteralNode(type)) return { node: type, parsed: fromParsed, isLiteral: true }
    return null
  }

  const specifier = fromParsed.imports.get(typeName)
  if (!specifier) return null
  const absPath = resolveModuleFile(fromParsed.absPath, specifier)
  if (!absPath) return null
  const target = parseFile(absPath)
  const declaration = target.declarations.get(typeName)
  if (!declaration) return null
  if (ts.isInterfaceDeclaration(declaration)) return { node: declaration, parsed: target }
  if (ts.isTypeAliasDeclaration(declaration) && declaration.type && ts.isTypeLiteralNode(declaration.type)) {
    return { node: declaration.type, parsed: target, isLiteral: true }
  }
  return null
}

function memberKind(member) {
  if (ts.isMethodSignature(member)) return 'method'
  if (ts.isPropertySignature(member)) {
    const type = member.type
    if (type && ts.isFunctionTypeNode(type)) {
      const name = member.name && member.name.getText()
      return name && /^(on|off|once|add|remove).*Listener|^on[A-Z]/.test(name) ? 'event' : 'fnProperty'
    }
    return 'property'
  }
  return 'other'
}

function memberName(member, source) {
  if (!member.name) return null
  const name = member.name.getText(source)
  return name.startsWith('[') || name.startsWith('"') || name.startsWith("'") ? null : name
}

function extractParams(member, source) {
  const parameters = member.parameters ?? []
  return parameters.map((parameter) => ({
    name: parameter.name.getText(source),
    type: parameter.type ? normalize(parameter.type.getText(source)) : 'unknown',
    required: !parameter.questionToken && !parameter.initializer && !(parameter.dotDotDotToken !== undefined),
    rest: Boolean(parameter.dotDotDotToken),
  }))
}

function extractMembers(node, source, { namespace, apiPathPrefix }) {
  const members = []
  for (const member of node.members) {
    const name = memberName(member, source)
    if (!name) continue
    const kind = memberKind(member)
    if (kind === 'other') continue

    const isCallable = kind === 'method' || kind === 'fnProperty' || kind === 'event'
    const signatureNode = kind === 'method' ? member : member.type
    members.push({
      namespace,
      name,
      kind,
      apiPath: `${apiPathPrefix}.${name}`,
      signature: normalize(member.getText(source)),
      params: isCallable ? extractParams(kind === 'method' ? member : member.type, source) : [],
      returns: normalize(member.type ? member.type.getText(source) : 'unknown'),
      callable: isCallable,
      optional: Boolean(member.questionToken),
    })
  }
  return members
}

/**
 * 解析契约。
 * @returns {{ contractPath: string, contractHash: string, apiGlobal: string,
 *   namespaces: Array<{ namespace: string, apiInterface: string|null, sourceFile: string,
 *     apiPathPrefix: string, resolved: boolean, members: Array<object> }> }}
 */
export function loadContract({ repoRoot = REPO_ROOT, entry = CONTRACT_ENTRY } = {}) {
  const absPath = resolve(repoRoot, entry)
  const parsed = parseFile(absPath)
  const source = parsed.source

  const exposed = parsed.declarations.get('ExposedAPI')
  if (!exposed || !ts.isInterfaceDeclaration(exposed)) {
    throw new Error(`未在 ${entry} 中找到 interface ExposedAPI，契约结构可能已变更`)
  }

  const namespaces = []
  for (const member of exposed.members) {
    if (!ts.isPropertySignature(member)) continue
    const namespace = memberName(member, source)
    if (!namespace) continue

    const apiPathPrefix = `${API_GLOBAL}.${namespace}`
    const typeNode = member.type
    const apiInterface = typeNode && ts.isTypeReferenceNode(typeNode) ? typeNode.typeName.getText(source) : null

    let node = null
    let nodeSource = source
    let sourceFile = entry
    if (typeNode && ts.isTypeReferenceNode(typeNode)) {
      const resolved = resolveInterfaceDeclaration(apiInterface, parsed)
      if (resolved) {
        node = resolved.node
        nodeSource = resolved.parsed.source
        sourceFile = resolved.parsed.absPath === absPath
          ? entry
          : resolved.parsed.absPath.slice(repoRoot.length + 1).replace(/\\/g, '/')
      }
    } else if (typeNode && ts.isTypeLiteralNode(typeNode)) {
      node = typeNode
    }

    namespaces.push({
      namespace,
      apiInterface,
      sourceFile,
      apiPathPrefix,
      resolved: Boolean(node),
      members: node ? extractMembers(node, nodeSource, { namespace, apiPathPrefix }) : [],
    })
  }

  const canonical = namespaces
    .map((ns) => `${ns.namespace}\t${ns.apiInterface ?? '-'}\t${ns.members.map((m) => `${m.name}:${m.signature}`).join('|')}`)
    .join('\n')

  return {
    contractPath: entry,
    contractHash: createHash('sha256').update(canonical).digest('hex').slice(0, 16),
    apiGlobal: API_GLOBAL,
    namespaces,
    memberCount: namespaces.reduce((sum, ns) => sum + ns.members.length, 0),
  }
}

/** 契约成员总数与命名空间数（供门禁与文档使用） */
export function contractSummary(contract) {
  return {
    contractPath: contract.contractPath,
    contractHash: contract.contractHash,
    namespaces: contract.namespaces.length,
    members: contract.memberCount,
    unresolved: contract.namespaces.filter((ns) => !ns.resolved).map((ns) => ns.namespace),
  }
}
