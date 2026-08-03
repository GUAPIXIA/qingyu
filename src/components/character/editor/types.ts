import type { Character } from '../../../../shared/types'
import type { RefObject, CSSProperties } from 'react'

/** textarea 自动调整高度(useTaResize)的返回值 */
export interface TaAutoSize {
  ref: RefObject<HTMLTextAreaElement | null>
  style: CSSProperties
}

/** 翻译相关共享 props */
export interface TranslateProps {
  translatedFields: Set<string>
  translatingField: string | null
  handleTranslateField: (field: string) => void
  handleTranslateGreeting: (index: number) => void
}

/** 区块组件基础 props */
export interface EditorSectionProps {
  form: Character
  update: (patch: Partial<Character>) => void
}
