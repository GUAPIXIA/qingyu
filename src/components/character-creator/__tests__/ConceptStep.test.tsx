import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within, act } from '@testing-library/react'
import { ConceptStep } from '../ConceptStep'
import { useCharacterCreatorStore } from '../../../store/useCharacterCreatorStore'
import { useSettingsStore } from '../../../store/useSettingsStore'
import { getDefaultSettings } from '../../../../shared/defaults'
import type { ConnectionProfile } from '../../../../shared/types'

const PROFILE: ConnectionProfile = {
  id: 'p1',
  name: 'test',
  provider: 'openai',
  baseUrl: 'https://api.example.com',
  apiKey: 'sk-test',
  model: 'gpt-4o',
  maxContext: 8192,
}

let doneCb: ((id: string) => void) | null = null
let chunkCb: ((d: { requestId: string; text: string }) => void) | null = null

/** 在 act 内触发流式完成（避免 store 更新未包 act 的警告） */
function completeStream(reqId: string, chunks: string[]) {
  act(() => {
    for (const c of chunks) chunkCb?.({ requestId: reqId, text: c })
    doneCb?.(reqId)
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  doneCb = null
  chunkCb = null
  useCharacterCreatorStore.getState().reset()
  useSettingsStore.setState({
    settings: {
      ...getDefaultSettings(),
      activeProfileId: 'p1',
      connectionProfiles: [PROFILE],
      activeModel: 'gpt-4o',
    },
  })
  ;(window.api.ai.onChunk as unknown as ReturnType<typeof vi.fn>).mockImplementation((cb: (d: { requestId: string; text: string }) => void) => {
    chunkCb = cb
    return () => {}
  })
  ;(window.api.ai.onDone as unknown as ReturnType<typeof vi.fn>).mockImplementation((cb: (id: string) => void) => {
    doneCb = cb
    return () => {}
  })
})

function lastRequestId(): string {
  const calls = (window.api.ai.chat as unknown as ReturnType<typeof vi.fn>).mock.calls
  return calls[calls.length - 1][0].requestId as string
}

describe('ConceptStep（概念设定）', () => {
  it('渲染 AI 扩展区与全部字段', () => {
    render(<ConceptStep />)
    expect(screen.getByText('AI 一句话扩展')).toBeInTheDocument()
    expect(screen.getByText('角色名')).toBeInTheDocument()
    expect(screen.getByText('角色描述')).toBeInTheDocument()
    expect(screen.getByText('首条消息')).toBeInTheDocument()
    expect(screen.getByText('高级设置（可选）')).toBeInTheDocument()
  })

  it('帮我写面板：输入想法后生成并填入字段', () => {
    render(<ConceptStep />)
    const personalityCard = screen.getByText('性格特征').closest('.field-card')!
    fireEvent.click(within(personalityCard as HTMLElement).getByText('帮我写'))
    // 面板展开
    const input = within(personalityCard as HTMLElement).getByPlaceholderText(/告诉 AI 你想要什么/)
    fireEvent.change(input, { target: { value: '想写个外冷内热的' } })
    fireEvent.click(within(personalityCard as HTMLElement).getByText('生成并修改'))
    // 触发流式完成
    completeStream(lastRequestId(), ['外冷内热，', '话不多但关心人'])
    expect(useCharacterCreatorStore.getState().draft.personality).toBe('外冷内热，话不多但关心人')
  })

  it('帮我写面板可收起且不触发生成', () => {
    render(<ConceptStep />)
    const card = screen.getByText('角色名').closest('.field-card')!
    fireEvent.click(within(card as HTMLElement).getByText('帮我写'))
    expect(within(card as HTMLElement).getByPlaceholderText(/告诉 AI 你想要什么/)).toBeInTheDocument()
    fireEvent.click(within(card as HTMLElement).getByText('收起'))
    expect(within(card as HTMLElement).queryByPlaceholderText(/告诉 AI 你想要什么/)).not.toBeInTheDocument()
    expect(window.api.ai.chat).not.toHaveBeenCalled()
  })

  it('帮我写面板支持 Ctrl+Enter 快速生成', () => {
    render(<ConceptStep />)
    const card = screen.getByText('角色描述').closest('.field-card')!
    fireEvent.click(within(card as HTMLElement).getByText('帮我写'))
    const input = within(card as HTMLElement).getByPlaceholderText(/告诉 AI 你想要什么/)
    fireEvent.change(input, { target: { value: '银发女黑客' } })
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
    expect(window.api.ai.chat).toHaveBeenCalledTimes(1)
    completeStream(lastRequestId(), ['银色短发，黑客装扮'])
    expect(useCharacterCreatorStore.getState().draft.description).toBe('银色短发，黑客装扮')
  })

  it('生成中按钮显示加载态', () => {
    // ai.chat 挂起（不触发完成）→ 保持生成中
    ;(window.api.ai.chat as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise(() => {}))
    render(<ConceptStep />)
    const card = screen.getByText('角色名').closest('.field-card')!
    fireEvent.click(within(card as HTMLElement).getByText('帮我写'))
    fireEvent.click(within(card as HTMLElement).getByText('生成'))
    expect(within(card as HTMLElement).getByText('生成中…')).toBeInTheDocument()
  })

  it('主首条消息的帮我写面板：生成到 firstMessage', () => {
    render(<ConceptStep />)
    const card = screen.getByText('首条消息').closest('.field-card')!
    fireEvent.click(within(card as HTMLElement).getByText('帮我写'))
    const input = within(card as HTMLElement).getByPlaceholderText(/告诉 AI 你想要什么/)
    fireEvent.change(input, { target: { value: '要冷淡一点' } })
    fireEvent.click(within(card as HTMLElement).getByText('生成并修改'))
    completeStream(lastRequestId(), ['*抬眼* "说正事。"'])
    expect(useCharacterCreatorStore.getState().draft.firstMessage).toBe('*抬眼* "说正事。"')
  })

  it('高级设置：启用作者注释后显示表单并保存', () => {
    render(<ConceptStep />)
    const switches = screen.getAllByRole('checkbox')
    fireEvent.click(switches[switches.length - 1]) // 作者注释启用（最后一个开关）
    const noteInput = screen.getByPlaceholderText(/2087 年的新上海/)
    fireEvent.change(noteInput, { target: { value: '故事发生在新上海' } })
    const draft = useCharacterCreatorStore.getState().draft
    expect(draft.authorNote?.enabled).toBe(true)
    expect(draft.authorNote?.text).toBe('故事发生在新上海')
  })

  it('标签输入回车添加，点击删除', () => {
    render(<ConceptStep />)
    const tagInput = screen.getByPlaceholderText('输入标签后回车')
    fireEvent.change(tagInput, { target: { value: '黑客' } })
    fireEvent.keyDown(tagInput, { key: 'Enter' })
    expect(useCharacterCreatorStore.getState().draft.tags).toEqual(['黑客'])
    // 删除
    fireEvent.click(screen.getByText('黑客').closest('span')!.querySelector('button')!)
    expect(useCharacterCreatorStore.getState().draft.tags).toEqual([])
  })

  it('备选开场白：添加/编辑/删除', () => {
    render(<ConceptStep />)
    fireEvent.click(screen.getByText('添加备选开场白'))
    fireEvent.click(screen.getByText('添加备选开场白'))
    expect(useCharacterCreatorStore.getState().draft.alternateGreetings).toEqual(['', ''])
    // 编辑第一条
    const textareas = screen.getAllByPlaceholderText(/备选开场白 \d+：与主消息不同风格的开场白/)
    fireEvent.change(textareas[0], { target: { value: '*推门而入* "来了？"' } })
    expect(useCharacterCreatorStore.getState().draft.alternateGreetings[0]).toBe('*推门而入* "来了？"')
    // 删除
    fireEvent.click(screen.getAllByTitle('删除此备选开场白')[0])
    expect(useCharacterCreatorStore.getState().draft.alternateGreetings).toHaveLength(1)
  })

  it('AI 扩展：输入概念并触发 ai.chat', () => {
    render(<ConceptStep />)
    const conceptInput = screen.getByPlaceholderText(/赛博朋克世界的女黑客/)
    fireEvent.change(conceptInput, { target: { value: '古风剑客' } })
    fireEvent.click(screen.getByText('AI 扩展'))
    expect(window.api.ai.chat).toHaveBeenCalledTimes(1)
    const params = (window.api.ai.chat as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(params.messages[1].content).toBe('古风剑客')
    // 触发完成 → 填充
    completeStream(lastRequestId(), ['{"name":"剑客","tags":["古风"]}'])
    expect(useCharacterCreatorStore.getState().draft.name).toBe('剑客')
  })
})
