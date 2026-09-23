import { useState, type ReactNode } from 'react'
import { Modal } from './Modal'

interface ConfirmDialogProps {
  open: boolean
  onClose: () => void
  onConfirm: () => void | Promise<void>
  title: string
  message: ReactNode
  confirmText?: string
  cancelText?: string
  danger?: boolean
  confirmBusyText?: string
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmText = '确认',
  cancelText = '取消',
  danger = false,
  confirmBusyText = '处理中…',
}: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleConfirm = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await onConfirm()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={title} width="sm" dismissible={!busy}>
      <div className="text-sm text-tavern-text-soft leading-relaxed">{message}</div>
      {error && (
        <p className="mt-3 text-xs text-tavern-danger" role="alert">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2 mt-6">
        <button className="btn-secondary" onClick={onClose} disabled={busy}>
          {cancelText}
        </button>
        <button
          className={danger ? 'btn-danger' : 'btn-primary'}
          onClick={handleConfirm}
          disabled={busy}
        >
          {busy ? confirmBusyText : confirmText}
        </button>
      </div>
    </Modal>
  )
}
