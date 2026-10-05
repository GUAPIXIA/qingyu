/**
 * 回填 android-parity-matrix.json 的 androidStatus（2026-09-26 验收刷新）。
 * 依据：Android 独立客户端阶段 3–6 实现 + 本轮源码核验。
 * 运行：node scripts/refresh-parity-matrix.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const jsonPath = join(root, 'docs', '架构', 'android-parity-matrix.json')
const mdPath = join(root, 'docs', '架构', 'android-parity-matrix.md')

/** capabilityId → { status, testId?, notes? } */
const UPDATES = {
  // ---- settings ----
  'settings.modelProviders': { status: 'full', testId: 'T-cap-model-profiles', notes: 'ConnectionProfileRepository + ModelClient（OpenAI/Claude/Gemini/Ollama）；阶段3 S3-06' },
  'settings.modelTestConnection': { status: 'full', testId: 'T-cap-model-test', notes: 'ModelClient.testConnection；ModelAdapterMockWebServerTest' },
  'settings.modelListModels': { status: 'full', testId: 'T-cap-model-list', notes: 'ChatRepository.listModels / LocalChatRepository' },
  'settings.credentialsSafeStorage': { status: 'full', testId: 'T-cap-secret-store', notes: 'KeystoreSecretStore（AES-256-GCM + EncryptedSharedPreferences）；S3-04' },
  'settings.appSettings': { status: 'full', testId: 'T-cap-app-settings', notes: 'LocalSettingsRepository 本地优先' },

  // ---- character ----
  'character.create': { status: 'full', testId: 'T-cap-char-create', notes: 'CharacterEditorViewModel.save / saveAndClose；阶段5' },
  'character.edit': { status: 'full', testId: 'T-cap-char-edit', notes: 'CharacterEditorViewModel' },
  'character.delete': { status: 'full', testId: 'T-cap-char-delete', notes: 'CharacterManagerScreen + LocalStore' },
  'character.importPng': { status: 'full', testId: 'T-cap-char-import-png', notes: 'CharacterCardCodec + importDocuments' },
  'character.importJson': { status: 'full', testId: 'T-cap-char-import-json', notes: 'CharacterCardCodec' },
  'character.importBatch': { status: 'full', testId: 'T-cap-char-import-batch', notes: 'importDocuments(List<PickedDocument>)' },
  'character.exportPng': { status: 'full', testId: 'T-cap-char-export-png', notes: 'CharacterEditorViewModel.export(format=png)' },
  'character.exportJson': { status: 'full', testId: 'T-cap-char-export-json', notes: 'CharacterEditorViewModel.export(format=json)' },
  'character.coverAvatarBackground': { status: 'full', testId: 'T-cap-char-media', notes: 'storeAvatar / cover 路径；SAF 选图' },
  'character.bindLorebook': { status: 'full', testId: 'T-cap-char-bind-lb', notes: 'bindEmbeddedLorebook + session/character lorebookIds' },

  // ---- chat 补齐 ----
  'chat.export': { status: 'full', testId: 'T-cap-chat-export', notes: 'ShareUtils.sessionExportText/Json（Markdown + JSON 规范化投影）' },
  'chat.quickReplyRuntime': { status: 'full', testId: 'T-cap-qr-runtime', notes: 'QuickReplyBar + ChatViewModel.onQuickReplyClick' },

  // ---- content ----
  'lorebook.manage': { status: 'full', testId: 'T-cap-lb-manage', notes: 'LorebookEditorViewModel.save/delete；canonical v2' },
  'lorebook.keywordTrigger': { status: 'full', testId: 'T-cap-lb-trigger', notes: 'ChatLorebookRuntime triggeredEntryKeys + 位置渲染' },
  'lorebook.importExport': { status: 'full', testId: 'T-cap-lb-io', notes: 'LorebookImportExport 多格式 + importWithTemplate' },
  'preset.manage': { status: 'full', testId: 'T-cap-preset-manage', notes: 'PresetEditorViewModel save/import/export' },
  'preset.applyRuntime': { status: 'full', testId: 'T-cap-preset-apply', notes: 'session.presetId / character.defaultPresetId + chatcore 透传' },
  'persona.manage': { status: 'full', testId: 'T-cap-persona-manage', notes: 'PersonaEditorViewModel' },
  'persona.injection': { status: 'full', testId: 'T-cap-persona-inject', notes: 'session.personaId + contextBuilder 人格流' },
  'regex.rules': { status: 'full', testId: 'T-cap-regex', notes: 'RegexEditorViewModel + ChatRegex' },
  'quickReply.manage': { status: 'full', testId: 'T-cap-qr-manage', notes: 'QuickReplyEditorViewModel + QuickReplyCodec' },

  // ---- P1：阶段 4–6 工程面 ----
  'settings.generationPlanning': { status: 'full', testId: 'T-cap-gen-plan', notes: 'contextBudget / 回复篇幅 / 推理门控（阶段4 S4-02）' },
  'settings.backupExportImport': { status: 'full', testId: 'T-cap-backup-v3', notes: 'BackupOrchestrator + BackupV3（含群数据 U-6-8）' },
  'settings.appearanceLocal': { status: 'full', testId: 'T-cap-appearance', notes: '本地外观/主题' },
  'settings.behavior': { status: 'full', testId: 'T-cap-behavior', notes: '行为/对话默认项' },
  'settings.updater': { status: 'full', testId: 'T-cap-updater', notes: 'UpdateService / UpdatePolicy' },
  'chat.imageAttachVision': { status: 'full', testId: 'T-cap-vision', notes: 'VisionImageInput + SAF；阶段6 同源管道' },
  'chat.commandSlash': { status: 'partial', testId: 'T-cap-slash', notes: '移动端命令面按等价入口裁剪；完整斜杠体系待产品确认是否 P1 必做' },
  'group.chatModes': { status: 'full', testId: 'T-cap-group-modes', notes: 'mention|polling|free + autoMode；GroupSessionPatch' },
  'group.autoMode': { status: 'full', testId: 'T-cap-group-auto', notes: 'autoMode + 间隔；阶段6' },
  'group.narrativeModes': { status: 'full', testId: 'T-cap-group-narrative', notes: 'immersive/omniscient + 跟随默认；D-14 口径' },
  'group.sessions': { status: 'full', testId: 'T-cap-group-sessions', notes: '群会话管理；阶段6' },
  'group.memory': { status: 'full', testId: 'T-cap-group-memory', notes: '群记忆 + GroupMemoryFeedback；阶段6' },
  'group.export': { status: 'full', testId: 'T-cap-group-export', notes: 'GroupExport 群口径 Markdown（D-14）' },
  'lorebook.healthCheck': { status: 'full', testId: 'T-cap-lb-health', notes: 'lorebook.healthCheck 等价' },
  'persona.narrativeRules': { status: 'full', testId: 'T-cap-narrative', notes: 'narrativeMode 契约 + 人格流' },
  'memory.autoManualMode': { status: 'full', testId: 'T-cap-mem-mode', notes: 'manual/auto；阶段4 S4-05' },
  'memory.history': { status: 'full', testId: 'T-cap-mem-history', notes: '事实/时间线/当前状态' },
  'memory.historyDegradation': { status: 'full', testId: 'T-cap-hist-degrade', notes: 'historyDegradation + shadow golden' },
  'semantic.embeddingConfig': { status: 'full', testId: 'T-cap-embed-cfg', notes: '远程→设备包→BM25 三级降级；D-9 不翻转' },
  'semantic.lorebookIndex': { status: 'full', testId: 'T-cap-lb-index', notes: 'EmbeddingTierPolicy + 语义索引' },
  'semantic.factSearch': { status: 'full', testId: 'T-cap-fact-search', notes: '事实向量检索；不可用时可解释降级' },
  'tts.voices': { status: 'full', testId: 'T-cap-tts', notes: '系统 TTS + OpenAI TTS 音色；Windows-only 音色标不适用' },
  'image.generate': { status: 'full', testId: 'T-cap-imagegen', notes: 'OpenAI Images / SD WebUI / ComfyUI 三端点；阶段6' },
  'attachments.file': { status: 'full', testId: 'T-cap-attach', notes: 'AttachmentIngestService + SAF' },

  // ---- 旧伴侣链路：S9-07 已退场 ----
  'settings.phoneConnectionProfiles': { status: 'removed', notes: 'S9-07 旧伴侣配对删除；保留空间/设备认证于 /sync/v1' },
  'settings.lanDiscovery': { status: 'removed', notes: 'S9-07 NSD/mDNS 旧发现删除；LAN 同步走扫码授权' },
  'settings.serverRelayChannel': { status: 'removed', notes: 'S9-07 /relay/v1 旧 RPC 删除；改 /sync/v1' },
  'settings.settingsSync': { status: 'removed', notes: '旧设置远程修改删除；设置走本地 + 同步实体 settings_public' },
  'bridge.deviceManage': { status: 'removed', notes: '旧配对设备管理删除；同步中心设备列表替代' },
  'bridge.taskRetryCancel': { status: 'removed', notes: '旧跨端任务 RPC 删除；本地 chatTasks retry/cancel 保留为 same' },

  // ---- P2：已实现或产品裁定 ----
  'mcp.remoteHttp': { status: 'partial', notes: '远程 HTTP MCP 契约在；完整权限确认 UI 待 P2' },
  'mcp.toolCall': { status: 'partial', notes: 'McpClient/ToolExecutor 在；移动端不启 stdio' },
  'mcp.serverManage': { status: 'partial', notes: '公开配置投影；stdio 标 PC-only' },
  'mcp.stdioOnly': { status: 'pc_only_confirmed', notes: '总方案 §3.2 产品确认' },
  'diagnostics.export': { status: 'partial', notes: 'DiagnosticsPackager/Redactor 在' },
  'diagnostics.connection': { status: 'full', notes: '连接诊断' },
  'localModels.catalog': { status: 'pc_only_confirmed', notes: 'D-16/阶段0 裁定 PC 优先；移动端 embedding 走设备包' },
  'localModels.lifecycle': { status: 'pc_only_confirmed', notes: '同上' },
  'image.comfyWorkflow': { status: 'pc_only_confirmed', notes: '桌面 Comfy 深度集成产品确认' },
  'file.fontManage': { status: 'pc_only_confirmed', notes: '桌面字体文件管理' },
  'help.assistant': { status: 'pc_only_confirmed', notes: '内容型桌面帮助' },
  'lorebook.keywordLocalization': { status: 'excluded', notes: 'D-16：本轮不纳入阶段6验收' },
  'chat.sessionStats': { status: 'excluded', notes: 'D-16：本轮不纳入阶段6验收' },
}

const VALID = new Set(['full', 'partial', 'none', 'removed', 'excluded', 'pc_only_confirmed'])

function main() {
  const m = JSON.parse(readFileSync(jsonPath, 'utf8'))
  let changed = 0
  const byStatus = { P0: {}, P1: {}, P2: {} }

  for (const c of m.capabilities) {
    const u = UPDATES[c.capabilityId]
    if (u) {
      if (!VALID.has(u.status)) throw new Error(`bad status ${u.status} for ${c.capabilityId}`)
      if (c.androidStatus !== u.status) changed++
      c.androidStatus = u.status
      if (u.testId) c.testId = u.testId
      if (u.notes !== undefined) c.notes = u.notes
    }
    const tier = c.targetTier
    if (!byStatus[tier]) byStatus[tier] = {}
    byStatus[tier][c.androidStatus] = (byStatus[tier][c.androidStatus] || 0) + 1
  }

  m.meta = {
    ...m.meta,
    generatedAt: '2026-09-26',
    refreshedAt: '2026-09-26',
    source: 'code-entry-audit + stage3-6 acceptance refresh',
    notes: [
      'platformPolicy pc_only_confirmed 依据总方案 §3.2/§4 产品边界签字（阶段0 冻结）。',
      '2026-09-26 刷新：androidStatus 以 Android 独立客户端实现与阶段3–6 报告为准，不再描述旧伴侣端。',
      'status=removed 表示旧伴侣链路 S9-07 已删除；status=excluded 表示 D-16 明确排除。',
      'P0 发布口径：full + equivalent(pc_only_confirmed 已产品确认) 为通过；none/partial 不得宣布完成。',
    ],
  }

  writeFileSync(jsonPath, JSON.stringify(m, null, 2) + '\n', 'utf8')

  // regenerate MD
  const rows = (tier) => m.capabilities
    .filter((c) => c.targetTier === tier)
    .map((c) => `| \`${c.capabilityId}\` | ${c.name} | ${c.androidStatus} | ${c.platformPolicy} | ${c.pcEntry} |`)
    .join('\n')

  const md = `# Android 能力对齐矩阵（可读导出）

> 权威源：\`android-parity-matrix.json\`
> 生成：阶段0 代码入口审计（2026-09-16）
> 刷新：2026-09-26 独立客户端验收（阶段3–6 实现核验）
> 校正：2026-10-03 PC entry／pcService 路径对齐三仓结构与 S9-07 旧链路删除（详见 JSON \`notes\`）

共 **${m.capabilities.length}** 项。

状态枚举：\`full\` / \`partial\` / \`none\` / \`removed\`（S9-07 旧链路退场） / \`excluded\`（D-16 排除） / \`pc_only_confirmed\`（产品确认仅 PC）。

## P0（${m.capabilities.filter((c) => c.targetTier === 'P0').length}）

| capabilityId | 名称 | Android | platformPolicy | PC entry |
|---|---|---|---|---|
${rows('P0')}

## P1（${m.capabilities.filter((c) => c.targetTier === 'P1').length}）

| capabilityId | 名称 | Android | platformPolicy | PC entry |
|---|---|---|---|---|
${rows('P1')}

## P2（${m.capabilities.filter((c) => c.targetTier === 'P2').length}）

| capabilityId | 名称 | Android | platformPolicy | PC entry |
|---|---|---|---|---|
${rows('P2')}
`
  writeFileSync(mdPath, md, 'utf8')

  console.log('changed rows:', changed)
  console.log('by tier/status:', JSON.stringify(byStatus, null, 2))
  const p0 = m.capabilities.filter((c) => c.targetTier === 'P0')
  const p0Ok = p0.filter((c) => c.androidStatus === 'full' || c.androidStatus === 'pc_only_confirmed' || c.androidStatus === 'removed' || c.androidStatus === 'excluded')
  const p0Bad = p0.filter((c) => c.androidStatus === 'none' || c.androidStatus === 'partial')
  console.log('P0 passable:', p0Ok.length, '/', p0.length)
  if (p0Bad.length) {
    console.log('P0 remaining:')
    for (const c of p0Bad) console.log(' ', c.androidStatus, c.capabilityId, c.name)
  }
}

main()
