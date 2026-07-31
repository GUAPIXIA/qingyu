/**
 * 角色图片资源 URL 辅助函数。
 *
 * 角色头像/封面通过 `tavern://` 自定义协议直接从磁盘按需加载，
 * 不再经 base64 编码通过 IPC 传输，大幅降低列表场景的内存与传输压力。
 */

/**
 * 构建角色图片的自定义协议 URL。
 *
 * @param id 角色 ID
 * @param kind 图片类型：'avatar'（头像）或 'cover'（封面）
 * @param version 版本戳（通常传 character.updatedAt），图片变更后强制浏览器重新加载
 */
export function charAssetUrl(id: string, kind: 'avatar' | 'cover', version?: number): string {
  const base = `tavern://character/${id}/${kind}`
  return version ? `${base}?v=${version}` : base
}
