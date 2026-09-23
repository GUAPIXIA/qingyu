import { ConfirmDialog } from './ConfirmDialog'
import { useConfirmStore } from '../../store/useConfirmStore'

/**
 * UEX-P1-04：全局确认宿主。挂在 MainLayout（与 ToastHost 同级），
 * 复用 ConfirmDialog 以继承 busy 防重入 / Esc / 焦点管理；
 * z-index 随 Modal 层级（50，Toast 为 40），保持既有错误提示层级不变。
 */
export function ConfirmHost() {
  const pending = useConfirmStore((s) => s.pending)
  const settle = useConfirmStore((s) => s.settle)
  const options = pending?.options

  return (
    <ConfirmDialog
      open={pending !== null}
      // 确认成功后 ConfirmDialog 会再调 onClose；settle 幂等，二次调用无副作用
      onClose={() => settle(false)}
      onConfirm={() => settle(true)}
      title={options?.title ?? ''}
      message={options?.message ?? ''}
      confirmText={options?.confirmText}
      cancelText={options?.cancelText}
      danger={options?.danger}
    />
  )
}
