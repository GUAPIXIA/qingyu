import { useState } from 'react'
import { cn } from '../../lib/utils'

interface CharacterAvatarProps {
  /** 角色头像 URL */
  avatar?: string
  /** 角色名称（用于 fallback 显示首字母） */
  name: string
  /** 头像尺寸，默认 'md' */
  size?: 'xs' | 'sm' | 'md' | 'lg'
  /** 自定义 className */
  className?: string
  /** fallback 背景色 */
  fallbackClassName?: string
}

const sizeClasses = {
  xs: 'w-5 h-5 text-[10px]',
  sm: 'w-6 h-6 text-[10px]',
  md: 'w-8 h-8 text-sm',
  lg: 'w-12 h-12 text-lg',
}

/**
 * 角色头像组件，内置图片加载失败 fallback。
 * 当头像 URL 加载失败时，自动显示角色名称首字母。
 */
export function CharacterAvatar({
  avatar,
  name,
  size = 'md',
  className,
  fallbackClassName,
}: CharacterAvatarProps) {
  const [imgError, setImgError] = useState(false)

  const showImg = avatar && !imgError
  const initials = name[0] ?? '?'

  return showImg ? (
    <img
      src={avatar}
      alt=""
      className={cn('rounded-full object-cover', sizeClasses[size], className)}
      onError={() => setImgError(true)}
    />
  ) : (
    <div
      className={cn(
        'rounded-full flex items-center justify-center font-bold',
        sizeClasses[size],
        fallbackClassName ?? 'bg-tavern-bg-hover text-tavern-text-muted',
        className,
      )}
    >
      {initials}
    </div>
  )
}
