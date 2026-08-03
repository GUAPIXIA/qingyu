import type { Character } from '../../../../shared/types'
import type { LegacyRef, CSSProperties } from 'react'

/** textarea 自动调整高度(useTaResize)的返回值 */
export interface TaAutoSize {
  ref: LegacyRef<HTMLTextAreaElement>
  style: CSSProperties
}

/** 可翻译的角色字段 */
export type TranslatableField = keyof Pick<Character, 'name' | 'description' | 'personality' | 'scenario' | 'firstMessage' | 'exampleDialog'>

/** 翻译相关共享 props */
export interface TranslateProps {
  translatedFields: Set<string>
  translatingField: string | null
  handleTranslateField: (field: TranslatableField) => Promise<void>
  handleTranslateGreeting: (index: number) => void
}

/** 区块组件基础 props */
export interface EditorSectionProps {
  form: Character
  update: (patch: Partial<Character>) => void
}
