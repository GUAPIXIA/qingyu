import { useState } from 'react'
import { useSpatialStore } from '../store/spatialStore.ts'

/** 托盘与画布共用头像；资源缺失或加载失败时显示文字。 */
export function ActorAvatar({ actorId, displayName, kind, assetRef }: {
  actorId: string
  displayName: string
  kind: 'persona' | 'character'
  assetRef?: string
}) {
  const linkedUrl = useSpatialStore((s) => {
    const value = s.actorAvatarUrls[actorId]
    return typeof value === 'string' ? value : undefined
  })
  const src = linkedUrl ?? assetRef
  const [failedUrl, setFailedUrl] = useState<string | null>(null)

  if (!src || src === failedUrl) return <>{kind === 'persona' ? '你' : displayName.slice(0, 1)}</>
  return <img className="actor-avatar-image" src={src} alt="" draggable={false} onError={() => setFailedUrl(src)} />
}
