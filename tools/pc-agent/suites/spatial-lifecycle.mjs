// 3C · 空间画板模块旅程：
//   数据面：建世界并绑定 → 编辑批次（CAS + 幂等）→ 上下文归属 → 开关不丢数据 → 重启恢复
//   界面面：打开嵌入画板 → 读取 iframe 内真实文本（验证 iframe 真实加载）
//   AI 面：提案/撤销/取消需要真实模型，按 pending 如实跳过。
import { createInvoker, createRecorder, finishSuite } from './index.mjs'

export const spatialLifecycleSuite = {
  id: 'spatial.lifecycle',
  description: '空间画板旅程：世界绑定、编辑批次 CAS/幂等、上下文归属、iframe 加载与重启恢复',

  async run({ request, sessionId, log = () => {} }) {
    const startedAt = new Date().toISOString()
    const recorder = createRecorder({ log })
    const invoke = createInvoker({ request, log })
    const stamp = Date.now().toString(36)

    const characterId = `qa-sp-char-${stamp}`
    const characterName = `QA-画板角色-${stamp}`
    const worldName = `QA-画板世界-${stamp}`
    const placeName = `QA-地点-${stamp}`
    let chatSessionId = null
    let snapshot = null

    await recorder.step('准备测试角色与会话', async () => {
      const now = Date.now()
      await invoke('character.save', [{
        id: characterId,
        name: characterName,
        avatar: '',
        description: '3C 画板旅程测试角色（隔离档案）',
        personality: '简短',
        scenario: '画板测试',
        firstMessage: '你好。',
        exampleDialog: '',
        tags: ['qa', '3c'],
        lorebookId: null,
        creator: 'pc-agent',
        createdAt: now,
        updatedAt: now,
        alternateGreetings: [],
      }])
      const session = await invoke('chat.createSession', [characterId, `QA-画板会话-${stamp}`])
      chatSessionId = session?.id ?? null
      recorder.expect(chatSessionId, 'createSession 未返回会话 id')
      return `${characterId} / ${chatSessionId}`
    })

    await recorder.step('创建并绑定空间世界', async () => {
      snapshot = await invoke('spatial.createAndBind', [characterId, chatSessionId, worldName])
      recorder.expect(snapshot?.version?.worldId, `快照缺少 version：${JSON.stringify(snapshot)?.slice(0, 120)}`)
      recorder.expect(snapshot?.world?.rootBoardId, '世界缺少 rootBoardId')
      const worlds = await invoke('spatial.listWorlds', [], { purpose: 'observe' })
      recorder.expect(worlds.some((item) => item.name === worldName), 'listWorlds 中找不到新建世界')
      const bound = await invoke('spatial.loadBound', [characterId, chatSessionId], { purpose: 'observe' })
      recorder.expect(bound?.version?.worldId === snapshot.version.worldId, 'loadBound 返回的世界不一致')
      return `worldId=${snapshot.version.worldId} revision=${snapshot.version.runtimeRevision}`
    })

    const buildCommit = (commitId, revision, fingerprint, commands) => ({
      commitId,
      worldId: snapshot.version.worldId,
      runtimeId: snapshot.version.runtimeId,
      bindingEpoch: snapshot.version.bindingEpoch,
      expectedRuntimeRevision: revision,
      expectedWorldFingerprint: fingerprint,
      commands,
    })

    let firstCommit = null

    /** 前置步骤失败时给出明确原因，而不是让后续步骤报 “reading 'world' of null” */
    const requireSnapshot = () => {
      if (!snapshot) throw new Error('前置步骤未成功（世界未创建或接口在当前构建中不存在），无法继续')
      return snapshot
    }

    await recorder.step('提交编辑批次：新建地点', async () => {
      requireSnapshot()
      const now = Date.now()
      const command = {
        type: 'create_node',
        payload: {
          id: `qa-place-${stamp}`,
          boardId: snapshot.world.rootBoardId,
          kind: 'place',
          name: placeName,
          description: 'QA 地点描述',
          tags: [],
          parentNodeId: null,
          childBoardId: null,
          createdAt: now,
          updatedAt: now,
          geometry: { x: 120, y: 160 },
          iconKey: 'place',
        },
      }
      firstCommit = buildCommit(`qa-commit-${stamp}`, snapshot.version.runtimeRevision, snapshot.version.worldFingerprint, [command])
      const result = await invoke('spatial.applyEditorBatch', [characterId, chatSessionId, firstCommit])
      recorder.expect(result?.ok === true, `提交未成功：${JSON.stringify(result)?.slice(0, 160)}`)
      recorder.expect(result.receipt?.revisionAfter > result.receipt?.revisionBefore, `revision 未推进：${JSON.stringify(result.receipt)}`)
      snapshot = result.snapshot
      const bound = await invoke('spatial.loadBound', [characterId, chatSessionId], { purpose: 'observe' })
      recorder.expect(bound.version.runtimeRevision === result.receipt.revisionAfter, '读回 revision 与回执不一致')
      return `revision ${result.receipt.revisionBefore} → ${result.receipt.revisionAfter}`
    })

    await recorder.step('幂等：原样重放同一 commit 返回 duplicate', async () => {
      requireSnapshot()
      // 幂等要求“同一请求原样重放”：commitId 与载荷绑定，改载荷会被判 commit_id_conflict（见下一步）
      const again = await invoke('spatial.applyEditorBatch', [characterId, chatSessionId, firstCommit])
      recorder.expect(again?.ok === true, `重复提交未成功：${JSON.stringify(again)?.slice(0, 140)}`)
      recorder.expect(again.duplicate === true, `重复提交未标记 duplicate：${JSON.stringify(again.duplicate)}`)
      recorder.expect(again.receipt?.revisionAfter === snapshot.version.runtimeRevision, `重复提交推进了 revision：${again.receipt?.revisionAfter}`)
      return `duplicate=true revision=${again.receipt.revisionAfter}`
    })

    await recorder.step('失败路径：同一 commitId 换载荷被判冲突', async () => {
      requireSnapshot()
      const now = Date.now()
      const tampered = {
        ...firstCommit,
        commands: [{
          type: 'create_node',
          payload: {
            id: `qa-place-tampered-${stamp}`,
            boardId: snapshot.world.rootBoardId,
            kind: 'place',
            name: `QA-不应写入-${stamp}`,
            description: '篡改载荷',
            tags: [],
            parentNodeId: null,
            childBoardId: null,
            createdAt: now,
            updatedAt: now,
            geometry: { x: 300, y: 300 },
            iconKey: 'place',
          },
        }],
      }
      const conflicted = await invoke('spatial.applyEditorBatch', [characterId, chatSessionId, tampered])
      recorder.expect(conflicted?.ok === false, `篡改载荷的重复 commitId 居然成功：${JSON.stringify(conflicted)?.slice(0, 120)}`)
      recorder.expect(conflicted.code === 'commit_id_conflict', `错误码=${conflicted.code}`)
      return `code=${conflicted.code}`
    })

    await recorder.step('失败路径：过期 CAS（revision 不匹配）被拒绝', async () => {
      requireSnapshot()
      const now = Date.now()
      const staleCommand = {
        type: 'create_node',
        payload: {
          id: `qa-place-stale-${stamp}`,
          boardId: snapshot.world.rootBoardId,
          kind: 'place',
          name: `QA-不应写入-${stamp}`,
          description: '过期提交',
          tags: [],
          parentNodeId: null,
          childBoardId: null,
          createdAt: now,
          updatedAt: now,
          geometry: { x: 200, y: 200 },
          iconKey: 'place',
        },
      }
      const stale = await invoke('spatial.applyEditorBatch', [characterId, chatSessionId, buildCommit(`qa-commit-stale-${stamp}`, 0, snapshot.version.worldFingerprint, [staleCommand])])
      recorder.expect(stale?.ok === false, `过期 revision 的提交居然成功：${JSON.stringify(stale)?.slice(0, 120)}`)
      recorder.expect(typeof stale.code === 'string' && stale.code.length > 0, `拒绝未给出错误码：${JSON.stringify(stale)}`)
      const after = await invoke('spatial.loadBound', [characterId, chatSessionId], { purpose: 'observe' })
      recorder.expect(after.version.runtimeRevision === snapshot.version.runtimeRevision, '被拒提交污染了 revision')
      return `code=${stale.code}`
    })

    await recorder.step('读取空间上下文（对象归属核对）', async () => {
      // 未启用画板时会话上下文为 null；先启用再读，属于真实前置条件
      await invoke('spatial.setEnabled', [characterId, chatSessionId, true])
      const context = await invoke('spatial.readContext', [characterId, chatSessionId], { purpose: 'observe' })
      recorder.expect(context && typeof context === 'object', `readContext 返回 ${context === null ? 'null' : typeof context}`)
      recorder.expect(context.version?.worldId === snapshot.version.worldId, '上下文版本与世界不一致')
      recorder.expect(typeof context.text === 'string', `text 类型=${typeof context.text}`)
      const containsPlace = context.text.includes(placeName)
      return `tokens=${context.tokens} text长度=${context.text.length} 含地点名=${containsPlace}`
    })

    await recorder.step('AI 会话初始态可读（无提案）', async () => {
      const aiSession = await invoke('spatial.getAiSession', [characterId, chatSessionId], { purpose: 'observe' })
      recorder.expect(Array.isArray(aiSession?.messages), `messages=${typeof aiSession?.messages}`)
      recorder.expect(Array.isArray(aiSession?.proposals), `proposals=${typeof aiSession?.proposals}`)
      const sources = await invoke('spatial.initializationSources', [characterId, chatSessionId], { purpose: 'observe' })
      recorder.expect(Array.isArray(sources?.sources), `initializationSources.sources=${typeof sources?.sources}`)
      const targets = await invoke('spatial.proposalTargets', [characterId, chatSessionId], { purpose: 'observe' })
      recorder.expect(Array.isArray(targets), `proposalTargets=${typeof targets}`)
      return `messages=${aiSession.messages.length} proposals=${aiSession.proposals.length} targets=${targets.length}`
    })

    await recorder.step('开关画板不丢数据', async () => {
      const before = await invoke('spatial.loadBound', [characterId, chatSessionId], { purpose: 'observe' })
      await invoke('spatial.setEnabled', [characterId, chatSessionId, false])
      const disabled = await invoke('spatial.loadBound', [characterId, chatSessionId], { purpose: 'observe' })
      recorder.expect(disabled.version.runtimeRevision === before.version.runtimeRevision, '关闭画板改变了 revision')
      await invoke('spatial.setEnabled', [characterId, chatSessionId, true])
      const enabled = await invoke('spatial.loadBound', [characterId, chatSessionId], { purpose: 'observe' })
      recorder.expect(enabled.version.worldFingerprint === before.version.worldFingerprint, '重新开启后世界指纹变化')
      return `revision=${enabled.version.runtimeRevision} 指纹一致`
    })

    await recorder.step('失败路径：绑定不存在的世界被拒绝', async () => {
      const outcome = await request('invoke', { action: 'spatial.bindWorld', args: [characterId, chatSessionId, 'no-such-world'] })
      recorder.expect(outcome.status !== 'succeeded', `绑定不存在的世界居然成功（status=${outcome.status}）`)
      const bound = await invoke('spatial.loadBound', [characterId, chatSessionId], { purpose: 'observe' })
      recorder.expect(bound.version.worldId === snapshot.version.worldId, '失败的绑定改变了会话绑定')
      return `${outcome.status} / ${outcome.error?.code ?? '-'}`
    })

    recorder.skip('画板 AI 提案流程（提问/审核/应用/撤销/取消）', '需要真实模型：spatial.askAi 及 proposal 系列共 23 个动作登记为 pending，awaitTask 与事件核对已就绪')

    await recorder.step('重启后画板数据恢复（重启恢复）', async () => {
      await request('session.restart')
      const bound = await invoke('spatial.loadBound', [characterId, chatSessionId], { purpose: 'observe' })
      recorder.expect(bound?.version?.worldId === snapshot.version.worldId, '重启后世界绑定丢失')
      recorder.expect(bound.version.runtimeRevision === snapshot.version.runtimeRevision, `重启后 revision=${bound.version.runtimeRevision}`)
      recorder.expect(bound.version.worldFingerprint === snapshot.version.worldFingerprint, '重启后世界指纹变化')
      return `worldId=${bound.version.worldId} revision=${bound.version.runtimeRevision}`
    })

    // ---- 界面面：嵌入画板是 iframe，验证真实加载 ----
    await recorder.step('UI：进入该角色的会话并打开空间画板', async () => {
      await invoke('ui.character.startChat', [characterName])
      await invoke('ui.spatial.openBoard', [])
      return '已点击“打开空间画板”'
    })

    await recorder.step('UI：读取画板 iframe 内真实文本（iframe 已加载）', async () => {
      const outcome = await request('invoke', { action: 'ui.spatial.readFrameText', args: [] })
      recorder.expect(outcome.status === 'succeeded', `读取 iframe 失败：${outcome.error?.message ?? outcome.status}`)
      const text = String(outcome.result ?? '')
      recorder.expect(text.length > 0, 'iframe 文本为空（画板可能未加载）')
      return text.replace(/\s+/g, ' ').slice(0, 80)
    })

    await recorder.step('UI：画板截图留证', async () => {
      const shot = await request('screenshot', { name: 'spatial-lifecycle-board.png' })
      return shot.path
    })

    await recorder.step('重启后重新打开画板（iframe 重建）', async () => {
      await request('session.restart')
      await invoke('ui.character.startChat', [characterName])
      await invoke('ui.spatial.openBoard', [])
      const outcome = await request('invoke', { action: 'ui.spatial.readFrameText', args: [] })
      recorder.expect(outcome.status === 'succeeded', `重启后读取 iframe 失败：${outcome.error?.message ?? outcome.status}`)
      recorder.expect(String(outcome.result ?? '').length > 0, '重启后 iframe 文本为空')
      const shot = await request('screenshot', { name: 'spatial-lifecycle-board-after-restart.png' })
      return `iframe 重建成功 · ${shot.path}`
    })

    return finishSuite({
      request,
      suiteId: this.id,
      sessionId,
      startedAt,
      recorder,
      targets: { characterId, characterName, chatSessionId, worldName, placeName, worldId: snapshot?.version?.worldId ?? null },
    })
  },
}

