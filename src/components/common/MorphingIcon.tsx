import { MorphIcon, type MorphIconProps } from 'morphicons/react'

/**
 * 状态对图标（morphicons 封装）。
 *
 * 普通图标仍用 `lucide-react` 的组件；只有「会原地切换」的图标对才用它：
 * 形参是图标**数据**（Lucide 的 `IconNode`，从 `lucide` 包按需导入，而非
 * `lucide-react` 的组件），`icon` 变化时按弹簧物理做形状形变，不写任何配对。
 *
 * ```tsx
 * <MorphingIcon icon={open ? ChevronUp : ChevronDown} className="w-4 h-4" />
 * ```
 *
 * - 默认 `reducedMotion="user"`：系统开启「减弱动态效果」时退化为瞬时切换；
 * - `size` / `color` / `strokeWidth` / `className` 等 SVG 属性与 lucide-react 一致；
 * - 只支持单色描边/填充图标（多色图标不做形变）。
 */
export function MorphingIcon({ reducedMotion = 'user', ...props }: MorphIconProps) {
  return <MorphIcon reducedMotion={reducedMotion} {...props} />
}

export type { MorphIconProps }
