/**
 * 桥接层白名单静态路由（方案 §4.2：tavern:// 协议安卓端不可达，提供等价静态路由）。
 *
 * 安全：所有路径经 pathGuard.safeId/safePath 校验（防路径穿越，§6.5）；
 * GET 类端点由 routes 的 originGuard 覆盖（浏览器 Origin 校验，§6.3）。
 *
 * 路由：
 *   /static/avatars/:characterId   角色头像（DIRS.characters()/{id}.{ext}）
 *   /static/covers/:characterId    角色封面
 *   /static/messages/:characterId/:sessionId/:messageId/:index  消息图片（base64 解码）
 */
import { Router } from 'express'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { DIRS } from '../services/storage'
import { chatData } from '../ipc/chat'
import { groupData } from '../ipc/group'
import { safeId } from '../utils/pathGuard'
import type { Request, Response } from 'express'

const AVATAR_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp']

/** 按魔数推断 MIME（与 PC 端 charCard 的 detectMimeType 等价实现） */
function detectMime(buf: Buffer): string {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif'
  if (buf.length >= 12 && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp'
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp'
  return 'application/octet-stream'
}

/** 读角色图片文件（头像/封面），找不到返回 null */
function readCharacterImage(characterId: string, prefix: 'avatar' | 'cover'): Buffer | null {
  const charDir = DIRS.characters()
  for (const ext of AVATAR_EXTS) {
    // avatar 为 {id}.{ext}；cover 为 {id}.cover.{ext}（对齐 charCard 存储约定）
    const name = prefix === 'avatar' ? `${characterId}.${ext}` : `${characterId}.cover.${ext}`
    const filePath = join(charDir, name)
    if (existsSync(filePath)) {
      try {
        return readFileSync(filePath)
      } catch {
        return null
      }
    }
  }
  return null
}

export function buildStaticRouter(): Router {
  const router = Router()

  router.get('/avatars/:characterId', (req: Request, res: Response) => {
    try {
      const characterId = safeId(req.params.characterId)
      const buf = readCharacterImage(characterId, 'avatar')
      if (!buf) {
        res.status(404).end()
        return
      }
      res.type(detectMime(buf)).send(buf)
    } catch {
      res.status(400).end()
    }
  })

  router.get('/covers/:characterId', (req: Request, res: Response) => {
    try {
      const characterId = safeId(req.params.characterId)
      const buf = readCharacterImage(characterId, 'cover')
      if (!buf) {
        res.status(404).end()
        return
      }
      res.type(detectMime(buf)).send(buf)
    } catch {
      res.status(400).end()
    }
  })

  // 消息图片：从会话 JSONL 读 Message.images[index]（base64）解码返回
  router.get(
    '/messages/:characterId/:sessionId/:messageId/:index',
    (req: Request, res: Response) => {
      try {
        const characterId = safeId(req.params.characterId)
        const sessionId = safeId(req.params.sessionId)
        const messageId = safeId(req.params.messageId)
        const index = Number(req.params.index)
        if (!Number.isInteger(index) || index < 0) {
          res.status(400).end()
          return
        }
        const messages = chatData.readMessages(characterId, sessionId)
        const target = messages.find((m) => m.id === messageId)
        const image = target?.images?.[index]
        if (!image) {
          res.status(404).end()
          return
        }
        const buf = Buffer.from(image, 'base64')
        res.type(detectMime(buf)).send(buf)
      } catch {
        res.status(400).end()
      }
    },
  )

  // 群聊消息图片：从群聊会话 JSONL 读 GroupMessage.images[index]（base64 解码）返回
  router.get(
    '/group-messages/:groupId/:sessionId/:messageId/:index',
    (req: Request, res: Response) => {
      try {
        const groupId = safeId(req.params.groupId)
        const sessionId = safeId(req.params.sessionId)
        const messageId = safeId(req.params.messageId)
        const index = Number(req.params.index)
        if (!Number.isInteger(index) || index < 0) {
          res.status(400).end()
          return
        }
        const messages = groupData.readMessages(groupId, sessionId)
        const target = messages.find((m) => m.id === messageId)
        const raw = target?.images?.[index]
        if (!raw) {
          res.status(404).end()
          return
        }
        // 兼容 data:image/...;base64,... 与纯 base64 两种存储形式
        const base64 = raw.startsWith('data:') ? raw.slice(raw.indexOf(',') + 1) : raw
        const buf = Buffer.from(base64, 'base64')
        res.type(detectMime(buf)).send(buf)
      } catch {
        res.status(400).end()
      }
    },
  )

  return router
}
