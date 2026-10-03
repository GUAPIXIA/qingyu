// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let directory: string
const streams: EventEmitter[] = []
beforeEach(() => { vi.resetModules(); directory = mkdtempSync(join(tmpdir(), 'qingyu-logger-')) })
afterEach(() => { vi.restoreAllMocks(); for (const stream of streams.splice(0)) stream.removeAllListeners(); rmSync(directory, {recursive:true,force:true}) })
const pipeError = () => Object.assign(new Error('broken pipe, write'), {code:'EPIPE'})
function output(name: 'stdout' | 'stderr') {
  const stream = Object.assign(new EventEmitter(), {destroyed:false,writable:true})
  streams.push(stream)
  vi.spyOn(process, name, 'get').mockReturnValue(stream as typeof process.stdout)
  return stream
}
describe('日志输出管道失效', () => {
  it('后台联验仅写文件时，不访问控制台输出', async () => {
    output('stdout'); output('stderr')
    const {initLogger,createLogger,LogLevel}=await import('../logger')
    const info=vi.spyOn(console,'log').mockImplementation(()=>{throw pipeError()})
    const error=vi.spyOn(console,'error').mockImplementation(()=>{throw pipeError()})
    initLogger(directory,LogLevel.DEBUG,{console:false}); createLogger('AI').info('开始'); createLogger('AI').error('失败')
    expect(info).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled()
    expect(readFileSync(join(directory,'logs/qingyu.log'),'utf8')).toContain('失败')
  })
  it.each(['info','warn','error'] as const)('同步 %s 输出 EPIPE 不打断业务，文件日志仍完整', async level => {
    output('stdout'); output('stderr')
    const {initLogger,createLogger} = await import('../logger')
    const method = level === 'info' ? 'log' : level
    const spy = vi.spyOn(console, method).mockImplementation(() => {throw pipeError()})
    expect(() => initLogger(directory)).not.toThrow()
    expect(() => createLogger('AI')[level]('AI 请求开始')).not.toThrow()
    expect(readFileSync(join(directory,'logs/qingyu.log'),'utf8')).toContain('AI 请求开始')
    spy.mockClear(); createLogger('AI')[level]('继续请求')
    expect(spy).not.toHaveBeenCalled()
  })
  it('异步 stdout EPIPE 不升级为未捕获异常，stderr 和文件继续输出', async () => {
    const stdout=output('stdout'); output('stderr')
    const {initLogger,createLogger} = await import('../logger')
    const info=vi.spyOn(console,'log').mockImplementation(()=>{}), error=vi.spyOn(console,'error').mockImplementation(()=>{})
    initLogger(directory)
    expect(()=>stdout.emit('error',pipeError())).not.toThrow()
    info.mockClear(); createLogger('AI').info('继续正文'); createLogger('AI').error('提取失败')
    expect(info).not.toHaveBeenCalled(); expect(error).toHaveBeenCalledOnce()
    expect(readFileSync(join(directory,'logs/qingyu.log'),'utf8')).toContain('继续正文')
  })
  it('关闭的输出流不再写入，重复日志不重复安装监听器', async () => {
    const stdout=output('stdout'); const stderr=output('stderr')
    const {initLogger,createLogger}=await import('../logger')
    stdout.destroyed=true
    const info=vi.spyOn(console,'log').mockImplementation(()=>{})
    initLogger(directory); createLogger('AI').info('一'); createLogger('AI').info('二')
    expect(info).not.toHaveBeenCalled(); expect(stdout.listenerCount('error')).toBe(1); expect(stderr.listenerCount('error')).toBe(1)
  })
  it('不吞掉与断管道无关的异常，原始日志仍已保存', async () => {
    output('stdout'); output('stderr')
    const {initLogger,createLogger}=await import('../logger')
    vi.spyOn(console,'log').mockImplementation(()=>{}); initLogger(directory)
    vi.spyOn(console,'log').mockImplementation(()=>{throw new Error('unexpected console failure')})
    expect(()=>createLogger('AI').info('原始记录')).toThrow('unexpected console failure')
    expect(readFileSync(join(directory,'logs/qingyu.log'),'utf8')).toContain('原始记录')
  })
  it('不吞掉其他输出流异步异常', async () => {
    const stdout=output('stdout'); output('stderr')
    const {initLogger}=await import('../logger')
    vi.spyOn(console,'log').mockImplementation(()=>{}); initLogger(directory)
    expect(()=>stdout.emit('error',Object.assign(new Error('unexpected I/O failure'),{code:'EIO'}))).toThrow('unexpected I/O failure')
  })
})
