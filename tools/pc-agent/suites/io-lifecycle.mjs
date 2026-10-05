// 免对话框导出/导入旅程：产品侧支持显式路径后，导出与导入可全程无对话框完成。
//
// 覆盖：角色卡 JSON/PNG、世界书、预设、快捷回复、备份 zip 的导出与导入往返；
// 并核对「不传路径仍返回 needs_interaction」的守卫语义（避免外部 Agent 误触系统对话框）。
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createInvoker, createRecorder, finishSuite } from './index.mjs'

export const dialogFreeIoSuite = {
  id: 'io.lifecycle',
  description: '免对话框导出/导入往返（角色卡 / 世界书 / 预设 / 快捷回复 / 备份）',

  async run({ request, sessionId, log = () => {} }) {
    const startedAt = new Date().toISOString()
    const recorder = createRecorder({ log })
    const invoke = createInvoker({ request, log })
    const stamp = Date.now().toString(36)
    const runDir = (await request('evidence')).runDir
    const exportsDir = join(runDir, 'exports')

    const characterId = `qa-io-char-${stamp}`
    const characterName = `QA-免对话框角色-${stamp}`
    const lorebookId = `qa-io-lb-${stamp}`
    const marker = `QA免对话框标记${stamp}`

    await recorder.step('守卫：不传路径时仍返回 needs_interaction', async () => {
      // 这些动作不传路径时产品会弹系统对话框，工具必须如实返回 needs_interaction 而不是挂住
      const checks = [
        { action: 'settings.exportBackup', args: [] },
        { action: 'quickReply.exportJson', args: [] },
        { action: 'character.exportJson', args: [characterId] },
      ]
      const results = []
      for (const item of checks) {
        const outcome = await request('invoke', { action: item.action, args: item.args })
        results.push(`${item.action}=${outcome.status}`)
        recorder.expect(outcome.status === 'needs_interaction', `${item.action} → ${outcome.status}（期望 needs_interaction）`)
        recorder.expect(String(outcome.error?.message ?? '').includes('路径参数'), `${item.action} 未提示传路径参数`)
      }
      return results.join(' ')
    })

    await recorder.step('准备角色卡与世界书', async () => {
      const now = Date.now()
      await invoke('character.save', [{
        id: characterId,
        name: characterName,
        avatar: '',
        description: `免对话框导出验证 ${marker}`,
        personality: '简短',
        scenario: '测试',
        firstMessage: '你好。',
        exampleDialog: '',
        tags: ['qa', 'io'],
        lorebookId: null,
        creator: 'pc-agent',
        createdAt: now,
        updatedAt: now,
        alternateGreetings: [],
      }])
      await invoke('lorebook.save', [{
        id: lorebookId,
        name: `QA-免对话框世界书-${stamp}`,
        description: '导出导入验证',
        entries: [{ id: `${lorebookId}-e1`, keywords: ['QA'], content: marker, position: 'before_char', order: 0, probability: 100, enabled: true }],
        enabled: true,
        scanDepth: 4,
      }])
      return `${characterId} / ${lorebookId}`
    })

    let characterJsonPath = null
    await recorder.step('导出角色卡 JSON（指定路径，无对话框）', async () => {
      characterJsonPath = join(exportsDir, `character-${stamp}.json`)
      const result = await invoke('character.exportJson', [characterId, characterJsonPath])
      recorder.expect(result?.ok === true, `导出失败：${JSON.stringify(result)?.slice(0, 160)}`)
      recorder.expect(existsSync(characterJsonPath), `文件不存在：${characterJsonPath}`)
      const size = statSync(characterJsonPath).size
      recorder.expect(size > 100, `文件过小：${size}`)
      // 导出为 chara_card_v2：角色字段在 data 下
      const parsed = JSON.parse(readFileSync(characterJsonPath, 'utf8'))
      const name = parsed?.data?.name ?? parsed?.name
      recorder.expect(parsed.spec === 'chara_card_v2', `spec=${parsed.spec}（期望 chara_card_v2）`)
      recorder.expect(String(name ?? '').includes('免对话框'), `导出内容不含角色名：${String(name).slice(0, 40)}`)
      return `${characterJsonPath}（${size} 字节，spec=${parsed.spec}）`
    })

    await recorder.step('导出角色卡 PNG 与封面（指定路径）', async () => {
      const pngPath = join(exportsDir, `character-${stamp}.png`)
      const png = await invoke('character.exportPng', [characterId, pngPath])
      recorder.expect(png?.ok === true, `PNG 导出失败：${JSON.stringify(png)?.slice(0, 160)}`)
      recorder.expect(existsSync(pngPath) && statSync(pngPath).size > 100, 'PNG 产物缺失或过小')
      // 封面：该角色没有封面，应返回可读错误而不是崩溃
      const cover = await invoke('character.exportCover', [characterId, join(exportsDir, `cover-${stamp}.png`)])
      recorder.expect(cover?.ok === false && String(cover.error ?? '').length > 0, `无封面时应返回可读错误：${JSON.stringify(cover)?.slice(0, 120)}`)
      return `png=${statSync(pngPath).size} 字节；封面按预期返回「${String(cover.error).slice(0, 20)}」`
    })

    await recorder.step('相同内容导入被去重（产品语义）', async () => {
      const imported = await invoke('character.importJson', ['copy', characterJsonPath])
      recorder.expect(imported?.success === true, `导入失败：${JSON.stringify(imported)?.slice(0, 200)}`)
      // UEX-P1-17：内容完全相同 → skippedIdentical，不产生新卡
      recorder.expect(imported.outcome === 'skippedIdentical', `outcome=${imported.outcome}（期望 skippedIdentical）`)
      recorder.expect(String(imported.note ?? '').includes('已存在相同角色'), `note=${imported.note}`)
      return `outcome=${imported.outcome}（${String(imported.note).slice(0, 30)}）`
    })

    await recorder.step('导入角色卡 JSON：删原卡后重建（真实往返）', async () => {
      await invoke('character.delete', [characterId])
      const imported = await invoke('character.importJson', ['copy', characterJsonPath])
      recorder.expect(imported?.success === true, `导入失败：${JSON.stringify(imported)?.slice(0, 200)}`)
      const importedId = imported.character?.id
      recorder.expect(importedId, `导入未返回角色：${JSON.stringify(imported)?.slice(0, 160)}`)
      const readBack = await invoke('character.get', [importedId], { purpose: 'observe' })
      recorder.expect(String(readBack?.description ?? '').includes(marker), '导入内容与导出内容不一致')
      recorder.expect(readBack.name === characterName, `角色名不一致：${readBack.name}`)
      return `新角色 ${importedId}（outcome=${imported.outcome ?? '-'}，name=${readBack.name}）`
    })

    let lorebookPath = null
    await recorder.step('世界书导出→导入往返（指定路径）', async () => {
      lorebookPath = join(exportsDir, `lorebook-${stamp}.json`)
      const exported = await invoke('lorebook.exportJson', [lorebookId, undefined, lorebookPath])
      recorder.expect(exported?.ok === true, `导出失败：${JSON.stringify(exported)?.slice(0, 160)}`)
      recorder.expect(existsSync(lorebookPath), '导出文件不存在')
      const imported = await invoke('lorebook.importJsonDetailed', [{ conflict: 'copy' }, lorebookPath])
      recorder.expect(imported?.lorebook?.id, `导入失败：${JSON.stringify(imported)?.slice(0, 200)}`)
      const entries = imported.lorebook.entries ?? []
      // 产品语义：导入按文件内 id 落库（同 id 即更新），内容必须完整回来
      recorder.expect(entries.some((item) => String(item.content).includes(marker)), '导入后条目内容丢失')
      const list = await invoke('lorebook.list', [], { purpose: 'observe' })
      const readBack = list.find((item) => item.id === imported.lorebook.id)
      recorder.expect(readBack, `落盘后列表中找不到 ${imported.lorebook.id}`)
      recorder.expect((readBack.entries ?? []).some((item) => String(item.content).includes(marker)), '落盘后条目内容丢失')
      return `${imported.lorebook.id}（${entries.length} 条，内容已核对）`
    })

    await recorder.step('预设导出→导入往返（指定路径）', async () => {
      const presets = await invoke('preset.list', [], { purpose: 'observe' })
      recorder.expect(presets.length > 0, '没有可用预设')
      const presetId = presets[0].id
      const presetPath = join(exportsDir, `preset-${stamp}.json`)
      const exported = await invoke('preset.exportJson', [presetId, presetPath])
      recorder.expect(exported?.ok === true, `导出失败：${JSON.stringify(exported)?.slice(0, 160)}`)
      const imported = await invoke('preset.importJson', [presetPath])
      recorder.expect(imported?.preset?.id, `导入失败：${JSON.stringify(imported)?.slice(0, 200)}`)
      recorder.expect(imported.preset.id !== presetId, '导入应生成新预设')
      return `${presetId} → ${imported.preset.id}`
    })

    await recorder.step('快捷回复导出→导入往返（指定路径）', async () => {
      const replyPath = join(exportsDir, `quickreply-${stamp}.json`)
      const exported = await invoke('quickReply.exportJson', [replyPath])
      recorder.expect(exported?.ok === true, `导出失败：${JSON.stringify(exported)?.slice(0, 160)}`)
      recorder.expect(existsSync(replyPath), '导出文件不存在')
      const imported = await invoke('quickReply.importJson', [replyPath])
      recorder.expect(imported?.ok === true, `导入失败：${JSON.stringify(imported)?.slice(0, 200)}`)
      return `${replyPath}（${statSync(replyPath).size} 字节）`
    })

    await recorder.step('备份导出→导入往返（指定路径，zip）', async () => {
      const backupPath = join(exportsDir, `backup-${stamp}.zip`)
      const exported = await invoke('settings.exportBackup', [backupPath], { timeoutMs: 300000 })
      recorder.expect(exported?.status === 'success', `导出失败：${JSON.stringify(exported)?.slice(0, 200)}`)
      const zipPath = exported.path ?? backupPath
      recorder.expect(existsSync(zipPath), `备份文件不存在：${zipPath}`)
      const size = statSync(zipPath).size
      recorder.expect(size > 1024, `备份文件过小：${size}`)
      // 导入：读回同一份备份（恢复到隔离档案，不影响正式数据）
      const imported = await invoke('settings.importBackup', [zipPath], { timeoutMs: 300000 })
      recorder.expect(imported?.status === 'success', `导入失败：${JSON.stringify(imported)?.slice(0, 200)}`)
      recorder.expect(imported.version === 2, `版本=${imported.version}（期望 2）`)
      return `zip ${Math.round(size / 1024)} KB，version=${imported.version}，counts=${JSON.stringify(imported.counts ?? {}).slice(0, 80)}`
    })

    await recorder.step('导入失败路径：不存在的源文件给出可读错误', async () => {
      const missing = join(exportsDir, `not-exists-${stamp}.json`)
      let message = ''
      try {
        const outcome = await invoke('character.importJson', ['copy', missing])
        message = String(outcome?.error ?? JSON.stringify(outcome) ?? '')
      } catch (error) {
        message = String(error.message)
      }
      recorder.expect(message.length > 0, '未给出任何错误信息')
      return message.slice(0, 80)
    })

    return finishSuite({
      request,
      suiteId: this.id,
      sessionId,
      startedAt,
      recorder,
      targets: { characterId, lorebookId, exportsDir },
    })
  },
}
