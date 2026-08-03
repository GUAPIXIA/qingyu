import { describe, it, expect } from 'vitest'
import { parseCommand, getCompletionContext } from '../parser'

describe('parseCommand 命令解析', () => {
  it('非命令输入返回 null', () => {
    expect(parseCommand('hello world')).toBeNull()
    expect(parseCommand('  普通文本')).toBeNull()
    expect(parseCommand('')).toBeNull()
  })

  it('解析命令名（小写化）与原始输入', () => {
    const result = parseCommand('/Clear')
    expect(result).toEqual({ name: 'clear', args: [], raw: '/Clear' })
  })

  it('纯斜杠返回 null', () => {
    expect(parseCommand('/')).toBeNull()
  })

  it('解析带空格的参数', () => {
    const result = parseCommand('/continue 请继续 后面的故事')
    expect(result?.name).toBe('continue')
    expect(result?.args).toEqual(['请继续', '后面的故事'])
  })

  it('支持双引号包裹的参数', () => {
    const result = parseCommand('/send "你好 世界" 测试')
    expect(result?.args).toEqual(['你好 世界', '测试'])
  })

  it('支持单引号包裹的参数', () => {
    const result = parseCommand("/imagine 'a cat' --mode face")
    expect(result?.args).toEqual(['a cat', '--mode', 'face'])
  })

  it('多空白字符分割参数', () => {
    const result = parseCommand('/continue   多   个    空格')
    expect(result?.args).toEqual(['多', '个', '空格'])
  })

  it('首尾空白被去除', () => {
    expect(parseCommand('  /help  ')).toEqual({ name: 'help', args: [], raw: '/help' })
  })

  it('参数去引号但保留中间空白', () => {
    const result = parseCommand('/plan "alpha  beta"')
    expect(result?.args).toEqual(['alpha  beta'])
  })
})

describe('getCompletionContext 补全上下文', () => {
  it('非命令返回 -1', () => {
    expect(getCompletionContext('hello', 3)).toBe(-1)
    expect(getCompletionContext('', 0)).toBe(-1)
  })

  it('命令名补全返回 0', () => {
    expect(getCompletionContext('/', 1)).toBe(0)
    expect(getCompletionContext('/he', 3)).toBe(0)
  })

  it('第一个参数补全返回 1', () => {
    expect(getCompletionContext('/help ', 6)).toBe(1)
    expect(getCompletionContext('/character A', 12)).toBe(1)
  })

  it('第二个参数补全返回 2', () => {
    expect(getCompletionContext('/swipe left ', 12)).toBe(2)
  })
})
