import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Loader2, RefreshCw, Sparkles, Users } from 'lucide-react'
import { nanoid } from 'nanoid'
import type { Character, GroupChat } from '../../../shared/types'
import { getDisplayName, replaceVariables } from '../../../shared/chat-core/variables'
import { GROUP_PREAMBLE_LIMITS } from '../../../shared/groupInitPreamble'
import { countVisibleCharacters } from '../../../shared/textMetrics'
import { charAssetUrl } from '../../utils/asset'
import { cn } from '../../lib/utils'
import { Modal } from '../common/Modal'
import {
  cancelGroupInitGeneration,
  generateGroupOpening,
  generateGroupPreamble,
} from '../../features/group-chat/groupInitRunner'
import { resolveGroupUserContext } from '../../features/group-chat/groupUserContext'
import { useCharacterStore } from '../../store/useCharacterStore'
import { useGroupChatStore } from '../../store/useGroupChatStore'
import { usePersonaStore } from '../../store/usePersonaStore'
import { useSettingsStore } from '../../store/useSettingsStore'
import { pushToast } from '../../store/useToastStore'

/** 初始化弹窗入口来源，决定打开后从哪一阶段开始。 */
export type GroupInitEntrySource = 'empty' | 'greeting' | 'settings' | 'opening'

export interface GroupInitPreambleModalProps {
  open: boolean
  group: GroupChat | null
  entry: GroupInitEntrySource
  onClose: () => void
  /** 用户选择“默认开场”时由页面打开现有 GreetingPickerModal。 */
  onChooseDefaultOpening: () => void
}

/** 四阶段状态机（方案 v2 §7.1）。 */
type Phase = 'review' | 'scene' | 'openingChoice' | 'openingPreview'

const PHASE_STEP: Record<Phase, number> = { review: 1, scene: 2, openingChoice: 3, openingPreview: 4 }

const PHASE_SUBTITLE: Record<Phase, string> = {
  review: '先统一角色初始环境，再开始对话',
  scene: 'AI 归纳的环境融合结果，可编辑后再应用',
  openingChoice: '选一种方式开始这场群聊',
  openingPreview: '确认开场旁白后插入为第一条消息',
}

/** 未配置对话 API 时的统一提示（方案 v2 §7.1）。 */
const API_MISSING_HINT = '请先在「模型 → 对话 API」配置 API 连接'

/**
 * 入口来源 → 初始阶段（方案 v2 §7.1/§7.2）：
 * - `empty`：始终从第 1 页开始（让用户有机会重新生成）；
 * - `greeting`：无共同场景 → 第 1 页；已有 → 第 3 页；
 * - `settings`：无共同场景 → 第 1 页；已有 → 第 2 页（编辑/重新生成预览）；
 * - `opening`：无共同场景 → 第 1 页；已有 → 第 3 页（直接选开场方式）。
 */
function resolveInitialPhase(entry: GroupInitEntrySource, hasPreamble: boolean): Phase {
  if (!hasPreamble) return 'review'
  if (entry === 'settings') return 'scene'
  if (entry === 'greeting' || entry === 'opening') return 'openingChoice'
  return 'review'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 群聊初始化「AI 前置设定」四阶段弹窗（方案 v2 §7.1）。
 *
 * ① 角色环境核对（只读，固定分析全体成员）→ ② 共同场景预览（流式/可停止/可编辑）
 * → ③ 开场方式二选一 → ④ 系统开场预览（流式/可编辑/失败可回退）。
 *
 * 约定：
 * - 生成器 `groupInitRunner` 不写库；本弹窗负责 `saveGroup(groupPreamble)` 与
 *   `insertNarrationMessage(开场旁白)`；
 * - 关闭 / 放弃 / 切换 group 或 entry 时取消在途生成（`cancelGroupInitGeneration`）；
 * - 生成中 `dismissible={false}`，避免请求与关闭竞态。
 */
export function GroupInitPreambleModal({
  open,
  group,
  entry,
  onClose,
  onChooseDefaultOpening,
}: GroupInitPreambleModalProps) {
  const characters = useCharacterStore((state) => state.characters)

  const [phase, setPhase] = useState<Phase>('review')
  // 第 2 页：共同场景
  const [sceneText, setSceneText] = useState('')
  const [sceneStream, setSceneStream] = useState('')
  const [sceneConflicts, setSceneConflicts] = useState<string[]>([])
  const [sceneModel, setSceneModel] = useState<string | undefined>(undefined)
  /** 最近一次 AI 生成结果：用于判断用户是否手改过正文（重新生成前二次确认）。 */
  const [lastAiScene, setLastAiScene] = useState('')
  const [sceneGenerating, setSceneGenerating] = useState(false)
  const [sceneError, setSceneError] = useState<string | null>(null)
  // 第 4 页：系统开场
  const [openingText, setOpeningText] = useState('')
  const [openingStream, setOpeningStream] = useState('')
  const [lastAiOpening, setLastAiOpening] = useState('')
  const [openingGenerating, setOpeningGenerating] = useState(false)
  const [openingError, setOpeningError] = useState<string | null>(null)

  // 请求令牌：停止/关闭/重开后旧回调一律丢弃，避免迟到结果覆盖当前界面
  const sceneRequestRef = useRef(0)
  const openingRequestRef = useRef(0)

  const groupId = group?.id ?? null

  /** 成员数据按 group.memberIds 映射；缺失成员跳过。 */
  const members = useMemo<Character[]>(() => {
    if (!group) return []
    return group.memberIds
      .map((id) => characters.find((character) => character.id === id))
      .filter((character): character is Character => !!character)
  }, [group, characters])

  const isBusy = sceneGenerating || openingGenerating

  // 打开弹窗 / 切换 group.id 或 entry 时重置阶段与本地编辑状态。
  // 注意：这里只按“入口”重置，不能依赖 group 对象——应用共同场景后页面会更新 currentGroup
  // 对象引用，若把 group 放进依赖会把当前步骤打回初始页。
  useEffect(() => {
    if (!open || groupId === null) return
    const preamble = group?.groupPreamble?.text?.trim() ? group.groupPreamble : undefined
    sceneRequestRef.current += 1
    openingRequestRef.current += 1
    setPhase(resolveInitialPhase(entry, !!preamble))
    setSceneText(preamble?.text ?? '')
    setSceneModel(preamble?.model)
    // 已有正文视为“上次认可的 AI 结果”，用户再改就触发重新生成确认
    setLastAiScene(preamble?.text ?? '')
    setSceneStream('')
    setSceneConflicts([])
    setSceneError(null)
    setSceneGenerating(false)
    setOpeningText('')
    setOpeningStream('')
    setLastAiOpening('')
    setOpeningError(null)
    setOpeningGenerating(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, groupId, entry])

  // 关闭 / 群切换 / 入口切换时取消在途生成（方案 v2 §7.1）
  useEffect(() => {
    if (!open || groupId === null) return
    const id = groupId
    return () => {
      const sessionId = useGroupChatStore.getState().currentSessionId
      if (sessionId) cancelGroupInitGeneration(id, sessionId)
    }
  }, [open, groupId, entry])

  // 所有 hooks 已声明完毕；关闭或没有群聊时不渲染（阶段重置由上面的 effect 负责）。
  if (!open || !group) return null

  const resolveSessionId = (): string | null => {
    const sessionId = useGroupChatStore.getState().currentSessionId
    if (!sessionId) {
      pushToast({ variant: 'warning', title: '当前会话未就绪，请稍后重试' })
      return null
    }
    return sessionId
  }

  /** 取消在途生成并停止流式状态（停止按钮 / 关闭 / 放弃共用）。 */
  const cancelInFlight = () => {
    sceneRequestRef.current += 1
    openingRequestRef.current += 1
    setSceneGenerating(false)
    setOpeningGenerating(false)
    setSceneStream('')
    setOpeningStream('')
    const sessionId = useGroupChatStore.getState().currentSessionId
    if (groupId && sessionId) cancelGroupInitGeneration(groupId, sessionId)
  }

  const closeModal = () => {
    cancelInFlight()
    onClose()
  }

  const startSceneGeneration = async () => {
    if (sceneGenerating) return
    const sessionId = resolveSessionId()
    if (!sessionId) return
    const token = ++sceneRequestRef.current
    setSceneGenerating(true)
    setSceneError(null)
    setSceneStream('')
    try {
      const result = await generateGroupPreamble({
        group,
        sessionId,
        members,
        onProgress: (text) => {
          if (sceneRequestRef.current === token) setSceneStream(text)
        },
        // 每次点击生成都换新的 attemptId，避免任务底座按 owner/feature 去重返回 null
        attemptId: nanoid(),
      })
      if (sceneRequestRef.current !== token) return
      setSceneGenerating(false)
      if (!result) return // 用户已停止/取消：保留原有正文
      setSceneText(result.scene)
      setLastAiScene(result.scene)
      setSceneConflicts(result.conflicts)
      setSceneModel(result.model)
    } catch (error) {
      if (sceneRequestRef.current !== token) return
      const message = errorMessage(error)
      setSceneGenerating(false)
      setSceneError(message)
      pushToast({ variant: 'error', title: '共同场景生成失败', description: message })
    }
  }

  const startOpeningGeneration = async () => {
    if (openingGenerating) return
    const scene = sceneText.trim()
    if (!scene) {
      pushToast({ variant: 'warning', title: '缺少共同场景，请先生成或填写共同场景' })
      return
    }
    const sessionId = resolveSessionId()
    if (!sessionId) return
    const token = ++openingRequestRef.current
    setOpeningGenerating(true)
    setOpeningError(null)
    setOpeningStream('')
    try {
      const result = await generateGroupOpening({
        group,
        sessionId,
        members,
        scene,
        onProgress: (text) => {
          if (openingRequestRef.current === token) setOpeningStream(text)
        },
        attemptId: nanoid(),
      })
      if (openingRequestRef.current !== token) return
      setOpeningGenerating(false)
      if (!result) return
      // 消息不会在渲染层展开宏：预览与落库前就替换为真实用户名/成员名，避免正文出现 {{user}}。
      const user = resolveGroupUserContext({
        settings: useSettingsStore.getState().settings,
        session: useGroupChatStore.getState().sessions.find((item) => item.id === sessionId),
        getPersona: usePersonaStore.getState().getPersona,
      })
      const resolved = replaceVariables(result.text, user.userName, members.map((member) => member.name).join('、'))
      setOpeningText(resolved)
      setLastAiOpening(resolved)
    } catch (error) {
      if (openingRequestRef.current !== token) return
      const message = errorMessage(error)
      setOpeningGenerating(false)
      setOpeningError(message)
      pushToast({ variant: 'error', title: '系统开场生成失败', description: message })
    }
  }

  // 未配置 API 时禁用生成入口；点击时再判一次（设置可能在弹窗打开后才就绪）。
  const apiReady = !!useSettingsStore.getState().getActiveProfile()

  const beginSceneAnalysis = () => {
    if (!useSettingsStore.getState().getActiveProfile()) {
      pushToast({ variant: 'warning', title: API_MISSING_HINT })
      return
    }
    if (members.length === 0) {
      pushToast({ variant: 'warning', title: '没有可分析的群成员角色卡' })
      return
    }
    setPhase('scene')
    void startSceneGeneration()
  }

  const regenerateScene = () => {
    if (sceneGenerating) return
    if (lastAiScene && sceneText.trim() !== lastAiScene.trim()) {
      if (!window.confirm('当前共同场景已被手动修改，重新生成会覆盖你的编辑。确定继续吗？')) return
    }
    void startSceneGeneration()
  }

  /** 应用共同场景：写群级 groupPreamble；设置面板入口应用后直接关闭，其余进入第 3 页。 */
  const applyScene = async () => {
    const text = sceneText.trim()
    if (!text) return
    try {
      await useGroupChatStore.getState().saveGroup({
        ...group,
        groupPreamble: {
          text,
          memberIds: [...group.memberIds],
          updatedAt: Date.now(),
          ...(sceneModel ? { model: sceneModel } : {}),
        },
      })
    } catch (error) {
      pushToast({ variant: 'error', title: '共同场景保存失败', description: errorMessage(error) })
      return
    }
    if (entry === 'settings') {
      onClose()
      return
    }
    setPhase('openingChoice')
  }

  const chooseSystemOpening = () => {
    if (!sceneText.trim()) {
      pushToast({ variant: 'warning', title: '缺少共同场景，无法生成系统开场' })
      return
    }
    setPhase('openingPreview')
    void startOpeningGeneration()
  }

  const regenerateOpening = () => {
    if (openingGenerating) return
    if (lastAiOpening && openingText.trim() !== lastAiOpening.trim()) {
      if (!window.confirm('当前开场旁白已被手动修改，重新生成会覆盖你的编辑。确定继续吗？')) return
    }
    void startOpeningGeneration()
  }

  /** 默认开场：取消在途生成后交给页面打开现有 GreetingPickerModal。 */
  const chooseDefaultOpening = () => {
    cancelInFlight()
    onChooseDefaultOpening()
    onClose()
  }

  /** 系统开场应用：以 narrator 旁白消息插入，然后关闭弹窗进入正常对话。 */
  const applyOpening = async () => {
    const text = openingText.trim()
    if (!text) return
    try {
      await useGroupChatStore.getState().insertNarrationMessage(text)
    } catch (error) {
      pushToast({ variant: 'error', title: '开场旁白写入失败', description: errorMessage(error) })
      return
    }
    onClose()
  }

  const sceneChars = countVisibleCharacters(sceneText)
  const sceneTooLong = sceneChars > GROUP_PREAMBLE_LIMITS.sceneMaxChars
  const openingChars = countVisibleCharacters(openingText)
  const openingTooLong = openingChars > GROUP_PREAMBLE_LIMITS.openingMaxChars

  const phaseStep = PHASE_STEP[phase]

  /** 第 2 页底部按钮。 */
  const sceneFooter = sceneGenerating ? (
    <button type="button" className="btn-secondary text-xs" onClick={cancelInFlight}>
      停止生成
    </button>
  ) : (
    <>
      <button type="button" className="btn-secondary text-xs" onClick={regenerateScene}>
        <RefreshCw className="mr-1 inline h-3 w-3" aria-hidden />
        重新生成
      </button>
      <button
        type="button"
        className="btn-primary text-xs"
        onClick={() => void applyScene()}
        disabled={!sceneText.trim() || sceneTooLong}
      >
        应用并进入开场选择
      </button>
      <button type="button" className="btn-ghost text-xs" onClick={closeModal}>
        放弃
      </button>
    </>
  )

  /** 第 4 页底部按钮：失败且无正文时提供重试/改选/手动开始。 */
  const openingFooter = openingGenerating ? (
    <button type="button" className="btn-secondary text-xs" onClick={cancelInFlight}>
      停止生成
    </button>
  ) : openingError && !openingText.trim() ? (
    <>
      <button type="button" className="btn-secondary text-xs" onClick={() => void startOpeningGeneration()}>
        重试
      </button>
      <button type="button" className="btn-secondary text-xs" onClick={chooseDefaultOpening}>
        改用默认开场
      </button>
      <button type="button" className="btn-ghost text-xs" onClick={closeModal}>
        手动开始
      </button>
    </>
  ) : (
    <>
      <button type="button" className="btn-secondary text-xs" onClick={regenerateOpening}>
        <RefreshCw className="mr-1 inline h-3 w-3" aria-hidden />
        重新生成
      </button>
      <button
        type="button"
        className="btn-primary text-xs"
        onClick={() => void applyOpening()}
        disabled={!openingText.trim() || openingTooLong}
      >
        应用并开始
      </button>
      <button type="button" className="btn-secondary text-xs" onClick={chooseDefaultOpening}>
        改用默认开场
      </button>
      <button type="button" className="btn-ghost text-xs" onClick={closeModal}>
        放弃
      </button>
    </>
  )

  return (
    <Modal
      open={open}
      onClose={closeModal}
      dismissible={!isBusy}
      width="custom"
      widthClassName="w-[640px]"
      headerClassName="px-5 py-4 bg-tavern-bg-soft"
      header={
        <div className="flex flex-1 min-w-0 items-center gap-3">
          <div
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-tavern-accent-soft text-tavern-accent"
            style={group.themeColor ? { backgroundColor: `${group.themeColor}20`, color: group.themeColor } : undefined}
          >
            <Sparkles className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="truncate font-display text-lg font-bold">{group.name}</h3>
            <p className="text-xs text-tavern-text-muted">{PHASE_SUBTITLE[phase]}</p>
          </div>
          <span className="shrink-0 rounded-full border border-tavern-border px-2 py-0.5 text-[10px] text-tavern-text-muted">
            第 {phaseStep} / 4 步
          </span>
        </div>
      }
      footer={
        phase === 'review' ? (
          <>
            {!apiReady && <span className="mr-auto text-xs text-tavern-warning">{API_MISSING_HINT}</span>}
            <button type="button" className="btn-secondary text-xs" onClick={closeModal}>
              跳过，手动开始
            </button>
            <button
              type="button"
              className="btn-primary text-xs"
              onClick={beginSceneAnalysis}
              disabled={!apiReady || members.length === 0}
              title={!apiReady ? API_MISSING_HINT : undefined}
            >
              AI 分析并生成共同场景
            </button>
          </>
        ) : phase === 'scene' ? (
          sceneFooter
        ) : phase === 'openingChoice' ? (
          <>
            <span className="mr-auto text-xs text-tavern-text-muted">
              也可以稍后手动开始；系统开场只在空会话可用。
            </span>
            <button type="button" className="btn-secondary text-xs" onClick={closeModal}>
              稍后手动开始
            </button>
          </>
        ) : (
          openingFooter
        )
      }
    >
      {phase === 'review' && (
        <div className="space-y-4">
          <div className="rounded-xl border border-tavern-accent/25 bg-tavern-accent-soft/40 p-3 text-xs leading-relaxed text-tavern-text-soft">
            AI 会阅读全体成员的设定，找出时间、地点、世界规则等初始环境冲突，融合成一段「群聊共同场景」。
            本次分析会调用一次当前对话模型；结果可以编辑，也可以跳过。
          </div>
          <div>
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="label mb-0">全体成员 · {members.length} 位</span>
              <span className="text-[10px] text-tavern-text-muted">v1 只读核对，固定分析全体成员</span>
            </div>
            <div className="space-y-2">
              {members.map((member) => {
                const avatar = member.avatar || charAssetUrl(member.id, 'avatar', member.updatedAt)
                const scenario = (member.translatedContent?.scenario || member.scenario || '').trim()
                return (
                  <div
                    key={member.id}
                    className="flex items-start gap-2.5 rounded-lg border border-tavern-border-soft bg-tavern-bg-soft px-3 py-2"
                  >
                    {avatar ? (
                      <img src={avatar} alt="" className="h-8 w-8 shrink-0 rounded-full object-cover" />
                    ) : (
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-tavern-bg-hover text-xs font-bold text-tavern-text-muted">
                        {(getDisplayName(member) || '?')[0]}
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium text-tavern-text">{getDisplayName(member)}</p>
                      <p className="mt-0.5 line-clamp-2 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-tavern-text-muted">
                        {scenario || '（未填写场景）'}
                      </p>
                    </div>
                  </div>
                )
              })}
            </div>
            {members.length === 0 && (
              <p className="rounded-lg border border-dashed border-tavern-border px-3 py-2 text-xs text-tavern-text-muted">
                没有找到可分析的成员角色卡，可跳过手动开始。
              </p>
            )}
          </div>
        </div>
      )}

      {phase === 'scene' && (
        <div className="space-y-4">
          {sceneGenerating ? (
            <div className="rounded-xl border border-tavern-border bg-tavern-bg-soft p-3">
              <div className="mb-2 flex items-center gap-2 text-xs text-tavern-accent">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                AI 正在融合角色初始环境…
              </div>
              <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-tavern-bg p-3 font-mono text-xs leading-relaxed text-tavern-text-soft">
                {sceneStream || '正在等待模型输出…'}
              </pre>
            </div>
          ) : (
            <>
              {sceneError && (
                <div
                  role="alert"
                  className="rounded-lg border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs leading-relaxed text-tavern-text-soft"
                >
                  <span className="flex items-center gap-1.5 font-medium text-tavern-danger">
                    <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
                    生成失败：{sceneError}
                  </span>
                  <p className="mt-1 text-tavern-text-muted">可以重新生成，或直接手写/修改下方正文后应用。</p>
                </div>
              )}
              <div>
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <span className="label mb-0">共同场景正文（可编辑）</span>
                  <span className={cn('text-[10px]', sceneTooLong ? 'text-tavern-danger' : 'text-tavern-text-muted')}>
                    {sceneChars} / {GROUP_PREAMBLE_LIMITS.sceneMaxChars} 字
                  </span>
                </div>
                <textarea
                  aria-label="共同场景正文"
                  value={sceneText}
                  onChange={(event) => setSceneText(event.target.value)}
                  rows={10}
                  placeholder="共同场景会注入每一轮群聊上下文，可手动编辑。"
                  className="w-full resize-y rounded-lg border border-tavern-border-soft bg-tavern-bg px-3 py-2 text-xs leading-relaxed text-tavern-text outline-none focus:border-tavern-accent"
                />
                {sceneTooLong && (
                  <p className="mt-1 text-[10px] text-tavern-danger">
                    正文超过 {GROUP_PREAMBLE_LIMITS.sceneMaxChars} 字上限，请精简后再应用。
                  </p>
                )}
              </div>
            </>
          )}
          {!sceneGenerating && sceneConflicts.length > 0 && (
            <div>
              <div className="mb-1.5 flex items-center gap-2">
                <span className="label mb-0">冲突清单</span>
                <span className="rounded bg-tavern-bg-hover px-1.5 py-0.5 text-[10px] text-tavern-text-muted">
                  AI 归纳，仅供参考
                </span>
              </div>
              <ul className="space-y-1 rounded-lg border border-tavern-border-soft bg-tavern-bg-soft p-3 text-xs leading-relaxed text-tavern-text-soft">
                {sceneConflicts.map((item, index) => (
                  <li key={index} className="flex gap-2">
                    <span className="shrink-0 text-tavern-accent" aria-hidden>·</span>
                    <span className="min-w-0 break-words">{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {phase === 'openingChoice' && (
        <div className="space-y-3">
          <button
            type="button"
            onClick={chooseSystemOpening}
            className="w-full rounded-xl border border-tavern-accent/40 bg-tavern-accent-soft/40 px-4 py-3.5 text-left transition-colors hover:border-tavern-accent hover:bg-tavern-accent-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tavern-accent/40"
          >
            <span className="flex items-center gap-2 text-sm font-semibold text-tavern-text">
              <Sparkles className="h-4 w-4 text-tavern-accent" aria-hidden />
              系统开场
            </span>
            <span className="mt-1 block text-xs text-tavern-text-muted">
              AI 依据共同场景生成一段开场旁白，作为第一条消息插入。
            </span>
          </button>
          <button
            type="button"
            onClick={chooseDefaultOpening}
            className="w-full rounded-xl border border-tavern-border bg-tavern-bg-soft px-4 py-3.5 text-left transition-colors hover:border-tavern-accent/60 hover:bg-tavern-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tavern-accent/40"
          >
            <span className="flex items-center gap-2 text-sm font-semibold text-tavern-text">
              <Users className="h-4 w-4 text-tavern-text-muted" aria-hidden />
              默认开场
            </span>
            <span className="mt-1 block text-xs text-tavern-text-muted">
              打开开场白选择，用某位角色的角色卡开场白开始对话。
            </span>
          </button>
        </div>
      )}

      {phase === 'openingPreview' && (
        <div className="space-y-4">
          {openingGenerating ? (
            <div className="rounded-xl border border-tavern-border bg-tavern-bg-soft p-3">
              <div className="mb-2 flex items-center gap-2 text-xs text-tavern-accent">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                AI 正在撰写系统开场…
              </div>
              <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-tavern-bg p-3 font-mono text-xs leading-relaxed text-tavern-text-soft">
                {openingStream || '正在等待模型输出…'}
              </pre>
            </div>
          ) : (
            <>
              {openingError && (
                <div
                  role="alert"
                  className="rounded-lg border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs leading-relaxed text-tavern-text-soft"
                >
                  <span className="flex items-center gap-1.5 font-medium text-tavern-danger">
                    <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
                    生成失败：{openingError}
                  </span>
                  <p className="mt-1 text-tavern-text-muted">可以重试、改用默认开场，或手动开始对话。</p>
                </div>
              )}
              <div>
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <span className="label mb-0">开场旁白（可编辑）</span>
                  <span className={cn('text-[10px]', openingTooLong ? 'text-tavern-danger' : 'text-tavern-text-muted')}>
                    {openingChars} / {GROUP_PREAMBLE_LIMITS.openingMaxChars} 字
                  </span>
                </div>
                <textarea
                  aria-label="系统开场旁白"
                  value={openingText}
                  onChange={(event) => setOpeningText(event.target.value)}
                  rows={8}
                  placeholder="系统开场会作为一条旁白消息插入，可手动编辑。"
                  className="w-full resize-y rounded-lg border border-tavern-border-soft bg-tavern-bg px-3 py-2 text-xs leading-relaxed text-tavern-text outline-none focus:border-tavern-accent"
                />
                {openingTooLong && (
                  <p className="mt-1 text-[10px] text-tavern-danger">
                    正文超过 {GROUP_PREAMBLE_LIMITS.openingMaxChars} 字上限，请精简后再应用。
                  </p>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </Modal>
  )
}
