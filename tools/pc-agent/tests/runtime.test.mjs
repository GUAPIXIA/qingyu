// 阶段 1 运行器自测：协议分帧、断言、动作校验与授权、构建身份、suite 注册表。
// 纯逻辑用例：不启动 Electron、不连接宿主、不调用模型。
import { describe, expect, it } from 'vitest'
import { checkPermission, dispatchAction, loadActions, unwrapDispatch, validateArgs } from '../lib/actions.mjs'
import { compare, resolvePath, runAssertionSpec, summarizeAssertions } from '../lib/assertions.mjs'
import { createLineDecoder, encodeMessage, pipePathFor } from '../lib/protocol.mjs'
import { buildIdentity, sanitizedEnv } from '../platform.mjs'
import { listSuites, loadSuite } from '../suites/index.mjs'

const actions = loadActions()

describe('协议分帧', () => {
  it('按行切分多条消息，并正确处理半包', () => {
    const received = []
    const decode = createLineDecoder((message) => received.push(message))
    decode(Buffer.from('{"a":1}\n{"b"'))
    expect(received).toEqual([{ a: 1 }])
    decode(Buffer.from(':2}\n'))
    expect(received).toEqual([{ a: 1 }, { b: 2 }])
  })

  it('非法 JSON 交给回调而不是静默丢弃', () => {
    const invalid = []
    const decode = createLineDecoder(() => {}, (line) => invalid.push(line))
    decode(Buffer.from('not-json\n'))
    expect(invalid).toEqual(['not-json'])
  })

  it('编码为单行 JSON 且以换行结尾', () => {
    expect(encodeMessage({ x: 1 })).toBe('{"x":1}\n')
  })

  it('管道名带宿主 id', () => {
    expect(pipePathFor('host-abc')).toBe('\\\\.\\pipe\\qingyu-pc-agent-host-abc')
  })
})

describe('断言', () => {
  it('resolvePath 支持嵌套字段与数组下标', () => {
    const value = { sessions: [{ id: 'a', meta: { title: 't0' } }, { id: 'b', meta: { title: 't1' } }] }
    expect(resolvePath(value, 'sessions[1].meta.title')).toBe('t1')
    expect(resolvePath(value, 'sessions[0].id')).toBe('a')
    expect(resolvePath(value, 'sessions[9].id')).toBeUndefined()
  })

  it('有限操作符语义正确', () => {
    expect(compare('t', 'equals', 't').pass).toBe(true)
    expect(compare([1, 2], 'contains', 2).pass).toBe(true)
    expect(compare('abcdef', 'contains', 'cde').pass).toBe(true)
    expect(compare([1, 2, 3], 'length', 3).pass).toBe(true)
    expect(compare(null, 'exists', null).pass).toBe(false)
    expect(compare(undefined, 'absent', null).pass).toBe(true)
    expect(compare(5, 'gte', 5).pass).toBe(true)
  })

  it('不支持的断言操作符被拒绝', async () => {
    await expect(runAssertionSpec({ action: 'app.getVersion', op: 'eval' }, { invokeAction: async () => ({ result: 1 }) }))
      .rejects.toThrow(/不支持的断言操作符/)
  })

  it('where 能按对象字段定位列表元素', async () => {
    const invokeAction = async () => ({ result: [{ id: 'a', title: 'x' }, { id: 'b', title: 'y' }] })
    const hit = await runAssertionSpec(
      { action: 'chat.listSessions', where: { path: 'id', equals: 'b' }, path: 'title', op: 'equals', expected: 'y' },
      { invokeAction },
    )
    expect(hit.pass).toBe(true)
    expect(hit.actual).toBe('y')

    const miss = await runAssertionSpec(
      { action: 'chat.listSessions', where: { path: 'id', equals: 'zzz' }, path: 'title', op: 'equals', expected: 'y' },
      { invokeAction },
    )
    expect(miss.pass).toBe(false)
    expect(miss.error).toMatch(/未找到满足 where 的对象/)
  })

  it('汇总统计按 pass 计数', () => {
    const summary = summarizeAssertions([{ pass: true }, { pass: false }, { pass: true }])
    expect(summary).toEqual({ total: 3, passed: 2, failed: 1 })
  })
})

describe('动作目录运行期视图', () => {
  it('磁盘目录中 3A 的动作已登记为可执行（含 UI 工具动作）', () => {
    for (const id of [
      'character.save', 'character.get', 'character.list', 'character.delete', 'character.bindLorebook',
      'chat.createSession', 'chat.renameSession', 'chat.listSessions', 'chat.getStats', 'chat.deleteSession',
      'chat.saveMessage', 'chat.listMessages', 'chat.exportChat', 'chat.toggleMemory',
      'settings.get', 'settings.save',
      'ai.countTokens', 'ai.getGenerationDiagnostics',
      'localModel.installed', 'localModel.storageUsage',
      'ui.navigate', 'ui.chat.readSelectedTitle', 'ui.character.startChat',
    ]) {
      expect(actions.executable.has(id), `${id} 未登记为可执行`).toBe(true)
    }
    expect(actions.executable.size).toBeGreaterThanOrEqual(39)
  })

  it('需要环境的动作是 pending 而不是冒充可执行', () => {
    for (const id of ['ai.chat', 'ai.cancelChat', 'chat.summarizeMemory']) {
      expect(actions.all.has(id)).toBe(true)
      expect(actions.executable.has(id)).toBe(false)
      expect(actions.all.get(id).status).toBe('pending')
      expect(String(actions.all.get(id).pendingReason).length).toBeGreaterThan(5)
    }
  })

  it('免对话框动作登记 dialog.pathArg；白名单闸门动作保持 pending 并说明原因', () => {
    // 产品侧支持显式路径后：传路径即可执行，不传路径由执行器返回 needs_interaction
    for (const id of ['character.exportJson', 'character.importJson', 'lorebook.exportJson', 'preset.exportJson', 'quickReply.exportJson', 'settings.exportBackup', 'settings.importBackup']) {
      const action = actions.all.get(id)
      expect(action, id).toBeTruthy()
      expect(action.status, id).toBe('mapped')
      expect(Number.isInteger(action.dialog?.pathArg), id).toBe(true)
      expect(actions.executable.has(id), id).toBe(true)
    }
    // 这两个动作故意不提供路径参数（「仅允许读取对话框选择过的路径」的白名单闸门）
    for (const id of ['file.selectImage', 'font.selectFont']) {
      const action = actions.all.get(id)
      expect(action.status, id).toBe('pending')
      expect(action.dialog?.pathArg, id).toBeUndefined()
      expect(String(action.pendingReason), id).toContain('故意不提供路径参数')
      expect(actions.executable.has(id), id).toBe(false)
    }
  })

  it('UI 工具动作带适配器声明且不是写动作', () => {
    const uiActions = [...actions.executable.values()].filter((action) => action.origin === 'tool')
    expect(uiActions.length).toBe(11)
    for (const action of uiActions) {
      expect(action.adapter).toBe('ui')
      expect(action.layer).toBe('ui')
      expect(action.write).toBe(false)
      expect(action.ui).toBeTruthy()
    }
    // F5 修复后已无 pending 的 UI 动作（ui.chat.selectSession 改为按菜单项语义定位并通过真实验证）
    const pendingUi = [...actions.all.values()].filter((action) => action.origin === 'tool' && action.status === 'pending')
    expect(pendingUi.map((action) => action.id)).toEqual([])
  })

  it('settings.get 登记了凭据脱敏键', () => {
    const action = actions.executable.get('settings.get')
    expect(action.redactKeys).toContain('apiKey')
    expect(action.write).toBe(false)
  })

  it('可执行动作都带描述与层级', () => {
    for (const action of actions.executable.values()) {
      expect(action.description).toBeTruthy()
      expect(['mock', 'service', 'ipc', 'ui']).toContain(action.layer)
    }
  })

  it('参数校验：缺参/多参被拒，正常参数通过', () => {
    const rename = actions.executable.get('chat.renameSession')
    expect(validateArgs(rename, [])).toMatch(/参数不足/)
    expect(validateArgs(rename, ['c', 's'])).toMatch(/参数不足/)
    expect(validateArgs(rename, ['c', 's', 't', 'extra'])).toMatch(/参数过多/)
    expect(validateArgs(rename, ['c', 's', 't'])).toBeNull()
  })

  it('写动作必须显式授权，读动作默认放行', () => {
    const write = actions.executable.get('character.save')
    const read = actions.executable.get('character.list')
    expect(checkPermission(write, [])).toMatch(/未授权写动作/)
    expect(checkPermission(write, ['character'])).toBeNull()
    expect(checkPermission(read, [])).toBeNull()
  })

  it('目录中读/写分类与业务事实一致', () => {
    expect(actions.executable.get('character.save').write).toBe(true)
    expect(actions.executable.get('chat.renameSession').write).toBe(true)
    expect(actions.executable.get('chat.listSessions').write).toBe(false)
    expect(actions.executable.get('app.getVersion').write).toBe(false)
  })

  it('dispatchAction 把不可调用路径转成 ACTION_NOT_FOUND', async () => {
    const fakePage = { evaluate: async () => ({ __dispatchError: '接口路径不存在：window.api.chat.ghost' }) }
    await expect(dispatchAction(fakePage, { apiPath: 'window.api.chat.ghost' }, [])).resolves.toEqual({ __dispatchError: '接口路径不存在：window.api.chat.ghost' })
    expect(() => unwrapDispatch({ __dispatchError: 'x' })).toThrow(/x/)
    expect(() => unwrapDispatch({ __callError: 'y' })).toThrow(/y/)
    expect(unwrapDispatch({ __value: 42 })).toBe(42)
  })
})

describe('平台与构建身份', () => {
  it('清除宿主注入的 ELECTRON_RUN_AS_NODE', () => {
    const { env, sanitized } = sanitizedEnv()
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect('ELECTRON_RUN_AS_NODE' in sanitized).toBe(true)
  })

  it('构建身份包含产物清单与陈旧判定', () => {
    const build = buildIdentity()
    expect(build.artifacts.length).toBe(3)
    expect(typeof build.stale).toBe('boolean')
    expect(Array.isArray(build.staleReasons)).toBe(true)
    expect(build.gitCommit === null || /^[0-9a-f]{6,}$/.test(build.gitCommit)).toBe(true)
  })

  it('陈旧判定忽略 __tests__ 与 *.test.* 文件', () => {
    const build = buildIdentity()
    expect(build.newestSource.path ?? '').not.toMatch(/__tests__|\.test\./)
  })
})

describe('suite 注册表', () => {
  it('注册全部十九条旅程，且未知 suite 返回 null', () => {
    expect(listSuites()).toEqual([
      'chat.basic', 'chat.lifecycle', 'character.lifecycle', 'settings.lifecycle',
      'group.lifecycle', 'lorebook.lifecycle', 'preset.lifecycle',
      'usage.lifecycle', 'log.lifecycle', 'system.lifecycle',
      'regex.lifecycle', 'quickreply.lifecycle', 'spatial.lifecycle', 'embedding.lifecycle', 'env.probe', 'llm.lifecycle', 'comfyui.lifecycle', 'tts.lifecycle', 'io.lifecycle',
    ])
    for (const id of listSuites()) expect(loadSuite(id)).toBeTruthy()
    expect(loadSuite('nope')).toBeNull()
  })

  it('每条旅程都有 id、说明与 run', () => {
    for (const id of listSuites()) {
      const suite = loadSuite(id)
      expect(suite.id).toBe(id)
      expect(suite.description.length).toBeGreaterThan(5)
      expect(typeof suite.run).toBe('function')
    }
  })
})









