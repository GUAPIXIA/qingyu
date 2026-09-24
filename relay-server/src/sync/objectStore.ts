/**
 * S8-02/03：对象存储适配器。
 * - key 为随机服务端 ID，不含用户文件名/实体 ID；
 * - 开发/单机用本地目录；生产可换 S3，接口保持不变；
 * - GC 先标记、延迟删除。
 */
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

export interface ObjectStore {
  put(data: Buffer): Promise<{ objectKey: string; size: number }>
  get(objectKey: string): Promise<Buffer>
  delete(objectKey: string): Promise<void>
  exists(objectKey: string): Promise<boolean>
}

export function newObjectKey(): string {
  return randomBytes(32).toString('hex')
}

export class FsObjectStore implements ObjectStore {
  constructor(private readonly root: string) {}

  private pathFor(objectKey: string): string {
    if (!/^[0-9a-f]{64}$/.test(objectKey)) {
      throw new Error('invalid object key')
    }
    // 双层前缀，避免单目录过大；key 本身随机
    return resolve(this.root, objectKey.slice(0, 2), objectKey)
  }

  async put(data: Buffer): Promise<{ objectKey: string; size: number }> {
    const objectKey = newObjectKey()
    const path = this.pathFor(objectKey)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, data)
    return { objectKey, size: data.length }
  }

  async get(objectKey: string): Promise<Buffer> {
    return readFile(this.pathFor(objectKey))
  }

  async delete(objectKey: string): Promise<void> {
    await rm(this.pathFor(objectKey), { force: true })
  }

  async exists(objectKey: string): Promise<boolean> {
    try {
      await stat(this.pathFor(objectKey))
      return true
    } catch {
      return false
    }
  }
}

/** 内存对象存储（单测） */
export class MemoryObjectStore implements ObjectStore {
  private readonly map = new Map<string, Buffer>()

  async put(data: Buffer): Promise<{ objectKey: string; size: number }> {
    const objectKey = newObjectKey()
    this.map.set(objectKey, data)
    return { objectKey, size: data.length }
  }

  async get(objectKey: string): Promise<Buffer> {
    const data = this.map.get(objectKey)
    if (!data) throw new Error('object not found')
    return data
  }

  async delete(objectKey: string): Promise<void> {
    this.map.delete(objectKey)
  }

  async exists(objectKey: string): Promise<boolean> {
    return this.map.has(objectKey)
  }

  get size(): number {
    return this.map.size
  }
}

export function cipherHashOf(data: Buffer): string {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`
}

export function joinKey(...parts: string[]): string {
  return join(...parts.filter(Boolean))
}
