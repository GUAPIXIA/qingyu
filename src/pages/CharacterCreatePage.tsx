import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import { WizardStepper } from '../components/character-creator/WizardStepper'
import { ConceptStep } from '../components/character-creator/ConceptStep'
import { CoverStep } from '../components/character-creator/CoverStep'
import { ReviewStep } from '../components/character-creator/ReviewStep'
import { Modal } from '../components/common/Modal'
import { ConfirmDialog } from '../components/common/ConfirmDialog'
import { useCharacterCreatorStore, DRAFT_KEY } from '../store/useCharacterCreatorStore'
import type { CreatorStep } from '../store/useCharacterCreatorStore'

export function CharacterCreatePage() {
  const navigate = useNavigate()
  const step = useCharacterCreatorStore((s) => s.step)
  const setStep = useCharacterCreatorStore((s) => s.setStep)
  const persistDraft = useCharacterCreatorStore((s) => s.persistDraft)
  const restoreDraft = useCharacterCreatorStore((s) => s.restoreDraft)
  const hasDraft = useCharacterCreatorStore((s) => s.hasDraft)
  const clearDraft = useCharacterCreatorStore((s) => s.clearDraft)

  const [showRestore, setShowRestore] = useState(false)
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false)
  const leavingRef = useRef<'back' | 'chat'>('back')
  const dirtyRef = useRef(false)

  // 草稿防抖持久化（500ms）：步骤或任何草稿内容变化时触发
  const draft = useCharacterCreatorStore((s) => s.draft)
  const coverBase64 = useCharacterCreatorStore((s) => s.coverBase64)
  const avatarPosition = useCharacterCreatorStore((s) => s.avatarPosition)

  useEffect(() => {
    const timer = setTimeout(() => {
      dirtyRef.current = true
      persistDraft()
    }, 500)
    return () => clearTimeout(timer)
  }, [step, draft, coverBase64, avatarPosition, persistDraft])

  // 进入页面时检查未完成草稿
  useEffect(() => {
    if (hasDraft()) setShowRestore(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 组件卸载时兜底保存一次（切换路由触发）
  useEffect(() => {
    return () => {
      if (dirtyRef.current) {
        useCharacterCreatorStore.getState().persistDraft()
      }
    }
  }, [])

  const handleLeave = (target: 'back' | 'chat') => {
    leavingRef.current = target
    if (dirtyRef.current && hasDraft()) {
      setShowLeaveConfirm(true)
    } else {
      doLeave()
    }
  }

  const doLeave = () => {
    // 离开时保持草稿（用户可下次恢复）；「直接放弃」才清除
    if (leavingRef.current === 'back') {
      useCharacterCreatorStore.getState().persistDraft()
    }
    navigate('/characters')
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* 顶部栏 */}
      <header className="flex items-center justify-between px-4 h-14 border-b border-tavern-border-soft bg-tavern-bg-soft shrink-0 gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            onClick={() => handleLeave('back')}
            className="flex items-center gap-1.5 text-sm text-tavern-text-soft hover:text-tavern-text transition-colors shrink-0"
          >
            <ArrowLeft className="w-4 h-4" />
            返回
          </button>
          <h1 className="font-display text-lg font-bold truncate">制作角色卡</h1>
        </div>
        <WizardStepper current={step} onStepClick={setStep} />
      </header>

      {/* 内容区 */}
      <div className="flex-1 overflow-y-auto p-4 sm:p-6">
        <div className="max-w-4xl mx-auto">
          {step === 0 && <ConceptStep />}
          {step === 1 && <CoverStep />}
          {step === 2 && <ReviewStep />}
        </div>
      </div>

      {/* 底部导航 */}
      <footer className="flex items-center justify-between px-4 h-14 border-t border-tavern-border-soft bg-tavern-bg-soft shrink-0">
        <button
          type="button"
          onClick={() => setStep(Math.max(0, step - 1) as CreatorStep)}
          disabled={step === 0}
          className="btn-secondary disabled:opacity-40"
        >
          <ArrowLeft className="w-4 h-4" />
          上一步
        </button>
        {step < 2 && (
          <button
            type="button"
            onClick={() => setStep(Math.min(2, step + 1) as CreatorStep)}
            className="btn-primary"
          >
            下一步
            <ArrowRight className="w-4 h-4" />
          </button>
        )}
      </footer>

      {/* 草稿恢复确认 */}
      <Modal open={showRestore} onClose={() => {}} title="发现未完成的草稿" width="sm">
        <div className="space-y-4">
          <p className="text-sm text-tavern-text-muted">
            检测到上次未完成的角色卡草稿，是否恢复继续编辑？
          </p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                clearDraft()
                setShowRestore(false)
              }}
            >
              不恢复
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={() => {
                const ok = restoreDraft()
                setShowRestore(false)
                if (!ok) clearDraft()
              }}
            >
              恢复草稿
            </button>
          </div>
        </div>
      </Modal>

      {/* 离开确认 */}
      <ConfirmDialog
        open={showLeaveConfirm}
        title="离开制作向导？"
        message="草稿会自动保存，下次进入可继续编辑。"
        confirmText="保存并离开"
        cancelText="继续编辑"
        onConfirm={() => {
          setShowLeaveConfirm(false)
          doLeave()
        }}
        onClose={() => setShowLeaveConfirm(false)}
      />
    </div>
  )
}

// 导出 DRAFT_KEY 供外部使用（如需要手动清理）
export { DRAFT_KEY }
