// 外部 Agent 工具自测：契约解析、目录覆盖、豁免、矩阵渲染、门禁失败路径。
// 纯逻辑用例，不启动 Electron、不调用模型、不改产品代码。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { contractSummary, loadContract } from '../lib/ipc-contract.mjs'
import {
  EXCLUSIONS_PATH,
  MATRIX_PATH,
  buildSkeleton,
  indexDocs,
  loadCatalog,
  loadExclusions,
  mergeCatalog,
  renderMatrix,
  validateCatalog,
} from '../lib/catalog-model.mjs'

const contract = loadContract()
const catalog = loadCatalog()
const exclusions = loadExclusions()
const matrixOnDisk = readFileSync(MATRIX_PATH, 'utf8')

function makeContract(namespaces) {
  const parsed = namespaces.map((entry) => ({
    namespace: entry.namespace,
    apiInterface: entry.apiInterface ?? 'TestAPI',
    sourceFile: 'shared/ipc-api.ts',
    apiPathPrefix: `window.api.${entry.namespace}`,
    resolved: true,
    members: (entry.members ?? []).map((name) => ({
      namespace: entry.namespace,
      name,
      kind: 'method',
      apiPath: `window.api.${entry.namespace}.${name}`,
      signature: `${name}(): void`,
      params: [],
      returns: 'void',
      callable: true,
      optional: false,
    })),
  }))
  return {
    contractPath: 'shared/ipc-api.ts',
    contractHash: 'testhash',
    apiGlobal: 'window.api',
    namespaces: parsed,
    memberCount: parsed.reduce((sum, ns) => sum + ns.members.length, 0),
  }
}

function makeCatalog(contractDoc, mutate) {
  const docs = buildSkeleton(contractDoc)
  if (mutate) mutate(docs)
  return { docs, ...indexDocs(docs) }
}

function emptyExclusions() {
  return { version: 1, note: '', entries: [] }
}

describe('契约解析', () => {
  it('解析出全部命名空间与成员，且无未解析接口', () => {
    const summary = contractSummary(contract)
    expect(summary.namespaces).toBe(28)
    expect(summary.members).toBe(256)
    expect(summary.unresolved).toEqual([])
    expect(summary.contractHash).toMatch(/^[0-9a-f]{16}$/)
  })

  it('跨文件接口按相对导入解析（localModel 来自 shared/localModels.ts）', () => {
    const localModel = contract.namespaces.find((ns) => ns.namespace === 'localModel')
    expect(localModel).toBeDefined()
    expect(localModel.sourceFile).toBe('shared/localModels.ts')
    expect(localModel.apiInterface).toBe('LocalModelAPI')
    expect(localModel.members.length).toBe(17)
  })

  it('每个成员的 apiPath 都挂在 window.api.<命名空间> 下，签名已规范化', () => {
    for (const ns of contract.namespaces) {
      expect(ns.apiPathPrefix).toBe(`window.api.${ns.namespace}`)
      for (const member of ns.members) {
        expect(member.apiPath).toBe(`${ns.apiPathPrefix}.${member.name}`)
        expect(member.signature).not.toMatch(/[\n\r]/)
        expect(member.signature.length).toBeGreaterThan(0)
      }
    }
  })
})

describe('动作目录覆盖', () => {
  it('磁盘上的目录覆盖全部契约成员，无遗漏', () => {
    const result = validateCatalog({ contract, catalog, exclusions, matrixText: matrixOnDisk })
    expect(result.errors).toEqual([])
    expect(result.coverage.missing).toBe(0)
    expect(result.coverage.total).toBe(contract.memberCount)
  })

  it('每个契约命名空间一个目录文件，且与契约成员数一致；工具动作单独成文件', () => {
    const contractDocs = catalog.docs.filter((doc) => contract.namespaces.some((ns) => ns.namespace === doc.namespace))
    const toolDocs = catalog.docs.filter((doc) => !contract.namespaces.some((ns) => ns.namespace === doc.namespace))
    expect(contractDocs.length).toBe(contract.namespaces.length)
    for (const doc of contractDocs) {
      const ns = contract.namespaces.find((item) => item.namespace === doc.namespace)
      expect(doc.actions.length).toBe(ns.members.length)
    }
    expect(toolDocs.length).toBe(1)
    expect(toolDocs[0].namespace).toBe('_tools')
    for (const action of toolDocs[0].actions) expect(action.origin).toBe('tool')
  })

  it('动作 id 全局唯一，状态合法', () => {
    const ids = []
    for (const doc of catalog.docs) {
      for (const action of doc.actions) {
        ids.push(action.id)
        expect(['unregistered', 'pending', 'mapped']).toContain(action.status)
        if (action.status === 'pending') expect(String(action.pendingReason ?? '').trim().length).toBeGreaterThan(0)
      }
    }
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('豁免清单', () => {
  it('每条豁免都带原因与登记时间，且指向仍然存在的契约成员', () => {
    const paths = new Set(contract.namespaces.flatMap((ns) => ns.members.map((m) => m.apiPath)))
    expect(exclusions.entries.length).toBeGreaterThan(0)
    for (const entry of exclusions.entries) {
      expect(entry.apiPath).toBeTruthy()
      expect(String(entry.reason ?? '').trim().length).toBeGreaterThan(0)
      expect(entry.registeredAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(paths.has(entry.apiPath)).toBe(true)
    }
  })

  it('豁免用于事件订阅与凭据接口，不用来掩盖可调用动作', () => {
    const byPath = new Map(
      contract.namespaces.flatMap((ns) => ns.members.map((member) => [member.apiPath, member])),
    )
    for (const entry of exclusions.entries) {
      const member = byPath.get(entry.apiPath)
      const isEvent = /^on[A-Z]/.test(member.name) && /=>\s*void$/.test(member.signature)
      const isCredential = /Credential$/.test(member.name)
      expect(isEvent || isCredential).toBe(true)
    }
  })

  it('凭据接口：读接口永久豁免，写接口为默认关闭的受控动作（方案 §4.4/§8）', () => {
    const paths = exclusions.entries.map((entry) => entry.apiPath)
    // 读接口不可调用：外部 Agent 永远读不到密钥明文
    expect(paths).toContain('window.api.settings.getAPICredential')
    expect(paths).not.toContain('window.api.settings.saveAPICredential')
    // 写接口登记为动作，但必须带 credential-write 要求（执行器据此默认拒绝）
    const writeAction = catalog.docs
      .flatMap((doc) => doc.actions)
      .find((action) => action.apiPath === 'window.api.settings.saveAPICredential')
    expect(writeAction).toBeTruthy()
    expect(writeAction.requires).toContain('credential-write')
    expect(writeAction.status).toBe('mapped')
  })
})

describe('能力矩阵', () => {
  it('磁盘矩阵与渲染结果一致（防止手改与陈旧）', () => {
    expect(renderMatrix({ contract, catalog, exclusions })).toBe(matrixOnDisk)
  })

  it('渲染是确定性的（同一输入两次结果相同）', () => {
    const first = renderMatrix({ contract, catalog, exclusions })
    const second = renderMatrix({ contract, catalog, exclusions })
    expect(first).toBe(second)
    expect(first).not.toMatch(/\d{4}-\d{2}-\d{2}T/) // 不写入时间戳，避免无意义 diff
  })

  it('矩阵统计与目录实际状态一致', () => {
    const result = validateCatalog({ contract, catalog, exclusions })
    const toolActions = catalog.docs
      .filter((doc) => !contract.namespaces.some((ns) => ns.namespace === doc.namespace))
      .flatMap((doc) => doc.actions)
    const toolIds = new Set(toolActions.map((action) => action.id))
    const contractActions = catalog.docs
      .flatMap((doc) => doc.actions)
      .filter((action) => !toolIds.has(action.id))

    expect(result.coverage.mapped).toBe(contractActions.filter((a) => a.status === 'mapped').length)
    expect(result.coverage.pending).toBe(contractActions.filter((a) => a.status === 'pending').length)
    expect(result.coverage.excluded).toBe(exclusions.entries.length)
    expect(result.coverage.unregistered).toBe(
      contractActions.filter((a) => a.status === 'unregistered').length - exclusions.entries.length,
    )
    expect(result.coverage.toolActions).toBe(toolActions.length)
  })
})

describe('门禁失败路径', () => {
  const smallContract = makeContract([{ namespace: 'chat', members: ['createSession', 'renameSession'] }])

  it('契约成员既未登记也未豁免 → 报错', () => {
    const broken = makeCatalog(smallContract, (docs) => {
      docs[0].actions = docs[0].actions.slice(0, 1)
      docs[0].actions[0].apiPath = smallContract.namespaces[0].members[0].apiPath
    })
    const result = validateCatalog({ contract: smallContract, catalog: broken, exclusions: emptyExclusions() })
    expect(result.errors.some((e) => e.includes('既未登记也未豁免'))).toBe(true)
  })

  it('签名漂移 → 报错并提示重新生成', () => {
    const broken = makeCatalog(smallContract, (docs) => {
      docs[0].actions[1].signature = 'renameSession(id: number): void'
    })
    const result = validateCatalog({ contract: smallContract, catalog: broken, exclusions: emptyExclusions() })
    const drift = result.errors.find((e) => e.includes('签名漂移'))
    expect(drift).toBeTruthy()
    expect(drift).toContain('pc-agent:catalog')
  })

  it('悬空映射（目录指向已不存在的契约成员）→ 报错', () => {
    const broken = makeCatalog(smallContract, (docs) => {
      docs[0].actions.push({ ...docs[0].actions[0], id: 'chat.ghost', apiPath: 'window.api.chat.ghost' })
    })
    const result = validateCatalog({ contract: smallContract, catalog: broken, exclusions: emptyExclusions() })
    expect(result.errors.some((e) => e.includes('悬空映射'))).toBe(true)
  })

  it('豁免缺少原因 / 指向不存在的成员 → 报错', () => {
    const broken = makeCatalog(smallContract)
    const result = validateCatalog({
      contract: smallContract,
      catalog: broken,
      exclusions: {
        version: 1,
        note: '',
        entries: [
          { apiPath: 'window.api.chat.createSession', reason: '   ' },
          { apiPath: 'window.api.chat.ghost', reason: '随便写的' },
        ],
      },
    })
    expect(result.errors.some((e) => e.includes('缺少 reason'))).toBe(true)
    expect(result.errors.some((e) => e.includes('悬空豁免'))).toBe(true)
  })

  it('动作 id 重复 → 报错', () => {
    const broken = makeCatalog(smallContract, (docs) => {
      docs[0].actions[1].id = docs[0].actions[0].id
    })
    const result = validateCatalog({ contract: smallContract, catalog: broken, exclusions: emptyExclusions() })
    expect(result.errors.some((e) => e.includes('id 重复'))).toBe(true)
  })

  it('status=mapped 但缺少 description/layer → 报错', () => {
    const broken = makeCatalog(smallContract, (docs) => {
      docs[0].actions[0].status = 'mapped'
    })
    const result = validateCatalog({ contract: smallContract, catalog: broken, exclusions: emptyExclusions() })
    expect(result.errors.some((e) => e.includes('缺少 description'))).toBe(true)
    expect(result.errors.some((e) => e.includes('layer 非法'))).toBe(true)
  })

  it('完成登记的 mapped 动作不报错', () => {
    const good = makeCatalog(smallContract, (docs) => {
      docs[0].actions[0].status = 'mapped'
      docs[0].actions[0].description = '创建会话'
      docs[0].actions[0].layer = 'ipc'
    })
    const result = validateCatalog({ contract: smallContract, catalog: good, exclusions: emptyExclusions() })
    expect(result.errors).toEqual([])
    expect(result.coverage.mapped).toBe(1)
    expect(result.coverage.unregistered).toBe(1)
  })

  it('--require-covered 等价开关：仍有 unregistered 即失败', () => {
    const good = makeCatalog(smallContract)
    const result = validateCatalog({ contract: smallContract, catalog: good, exclusions: emptyExclusions(), requireCovered: true })
    expect(result.errors.some((e) => e.includes('--require-covered'))).toBe(true)
  })

  it('矩阵陈旧 → 报错', () => {
    const good = makeCatalog(smallContract)
    const result = validateCatalog({
      contract: smallContract,
      catalog: good,
      exclusions: emptyExclusions(),
      matrixText: '# 被人手改过的矩阵\n',
    })
    expect(result.errors.some((e) => e.includes('能力矩阵'))).toBe(true)
  })
})

describe('目录刷新合并', () => {
  it('保留人工登记字段，补充新增成员，并报告悬空登记', () => {
    const before = makeContract([{ namespace: 'chat', members: ['createSession'] }])
    const existing = makeCatalog(before, (docs) => {
      docs[0].actions[0].status = 'mapped'
      docs[0].actions[0].id = 'chat.session.create'
      docs[0].actions[0].description = '创建会话'
      docs[0].actions[0].layer = 'ui'
      docs[0].actions[0].assertions = ['会话存在于列表']
    })

    const after = makeContract([{ namespace: 'chat', members: ['createSession', 'renameSession'] }])
    const merged = mergeCatalog(buildSkeleton(after), existing)

    const first = merged.docs[0].actions.find((a) => a.apiPath === 'window.api.chat.createSession')
    expect(first.status).toBe('mapped')
    expect(first.id).toBe('chat.session.create')
    expect(first.layer).toBe('ui')
    expect(first.assertions).toEqual(['会话存在于列表'])
    expect(merged.docs[0].actions.find((a) => a.apiPath === 'window.api.chat.renameSession').status).toBe('unregistered')

    // 契约成员消失 → 报告但不静默删除
    const shrunken = makeContract([{ namespace: 'chat', members: ['renameSession'] }])
    const mergedAfter = mergeCatalog(buildSkeleton(shrunken), merged)
    expect(mergedAfter.dropped.map((item) => item.apiPath)).toContain('window.api.chat.createSession')
    expect(mergedAfter.docs[0].actions.length).toBe(1)
  })

  it('豁免清单文件可被解析且格式稳定', () => {
    const raw = JSON.parse(readFileSync(EXCLUSIONS_PATH, 'utf8'))
    expect(raw.version).toBe(1)
    expect(Array.isArray(raw.entries)).toBe(true)
    expect(String(raw.note).length).toBeGreaterThan(0)
  })
})

