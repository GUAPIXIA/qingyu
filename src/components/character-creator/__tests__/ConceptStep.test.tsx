import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within, act, waitFor } from '@testing-library/react'
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
async function completeStream(reqId: string, chunks: string[]) {
  await act(async () => {
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
  ;(window.api.ai.onComplete as unknown as ReturnType<typeof vi.fn>).mockImplementation((cb: (p: { requestId: string; finishReason?: string }) => void) => {
    doneCb = (id) => cb({ requestId: id, finishReason: 'stop' })
    return () => {}
  })
})

function lastRequestId(): string {
  const calls = (window.api.ai.chat as unknown as ReturnType<typeof vi.fn>).mock.calls
  return calls[calls.length - 1][0].requestId as string
}

describe('ConceptStep（概念设定）', () => {
  it('角色扩展期间用户编辑后，保留旧建议且不自动覆盖', async () => {
    render(<ConceptStep />)
    fireEvent.change(screen.getByPlaceholderText(/赛博朋克世界的女黑客/), { target: { value: '古风剑客' } })
    fireEvent.click(screen.getByText('AI 扩展'))
    await waitFor(() => expect(window.api.ai.chat).toHaveBeenCalledTimes(1))
    act(() => useCharacterCreatorStore.getState().updateDraft({ name: '用户新名字' }))
    await completeStream(lastRequestId(), ['{"name":"旧剑客"}'])
    expect(useCharacterCreatorStore.getState().draft.name).toBe('用户新名字')
    expect(screen.getByDisplayValue(/旧剑客/)).toBeInTheDocument()
    expect(useCharacterCreatorStore.getState().isExpanding).toBe(false)
  })

  it('字段来源原值在发起时冻结，改后改回也阻止旧建议替换', async () => {
    act(() => useCharacterCreatorStore.getState().updateDraft({ description: '原描述' }))
    const running = useCharacterCreatorStore.getState().aiGenerateField('description')
    await running
    act(() => useCharacterCreatorStore.getState().updateDraft({ description: '新描述' }))
    act(() => useCharacterCreatorStore.getState().updateDraft({ description: '原描述' }))
    await completeStream(lastRequestId(), ['旧描述建议'])
    expect(useCharacterCreatorStore.getState().pendingGeneration?.original).toBe('原描述')
    act(() => useCharacterCreatorStore.getState().applyGenerated('replace'))
    expect(useCharacterCreatorStore.getState().draft.description).toBe('原描述')
    expect(useCharacterCreatorStore.getState().pendingGeneration?.content).toBe('旧描述建议')
    expect(useCharacterCreatorStore.getState().error).toContain('草稿已变化')
  })
  it('渲染 AI 扩展区与全部字段', () => {
    render(<ConceptStep />)
    expect(screen.getByText('AI 一句话扩展')).toBeInTheDocument()
    expect(screen.getByText('角色名')).toBeInTheDocument()
    expect(screen.getByText('角色描述')).toBeInTheDocument()
    expect(screen.getByText('首条消息')).toBeInTheDocument()
    expect(screen.getByText('高级设置（可选）')).toBeInTheDocument()
  })

  // UEX-P2-07：旧用例「生成即覆盖」按新语义同步——生成后不直接覆盖，三选后才写入
  it('帮我写面板：生成后不直接覆盖，点「替换」才写入字段', async () => {
    render(<ConceptStep />)
    const personalityCard = screen.getByText('性格特征').closest('.field-card')!
    fireEvent.click(within(personalityCard as HTMLElement).getByText('帮我写'))
    // 面板展开
    const input = within(personalityCard as HTMLElement).getByPlaceholderText(/告诉 AI 你想要什么/)
    fireEvent.change(input, { target: { value: '想写个外冷内热的' } })
    fireEvent.click(within(personalityCard as HTMLElement).getByText('生成并修改'))
    await waitFor(() => expect(window.api.ai.chat).toHaveBeenCalledTimes(1))
    // 触发流式完成
    await completeStream(lastRequestId(), ['外冷内热，', '话不多但关心人'])
    // UEX-P2-07：不直接覆盖字段，出现内联预览卡 + 替换/追加/放弃
    expect(useCharacterCreatorStore.getState().draft.personality).toBe('')
    expect(within(personalityCard as HTMLElement).getByText(/AI 已生成/)).toBeInTheDocument()
    expect(within(personalityCard as HTMLElement).getByText('替换')).toBeInTheDocument()
    expect(within(personalityCard as HTMLElement).getByText('追加')).toBeInTheDocument()
    expect(within(personalityCard as HTMLElement).getByText('放弃')).toBeInTheDocument()
    fireEvent.click(within(personalityCard as HTMLElement).getByText('替换'))
    expect(useCharacterCreatorStore.getState().draft.personality).toBe('外冷内热，话不多但关心人')
    // 应用后预览卡消失
    expect(within(personalityCard as HTMLElement).queryByText('替换')).not.toBeInTheDocument()
  })

  it('三选：「追加」接到当前内容之后（基于最新输入）', async () => {
    useCharacterCreatorStore.getState().updateDraft({ description: '已有内容' })
    render(<ConceptStep />)
    const card = screen.getByText('角色描述').closest('.field-card')!
    fireEvent.click(within(card as HTMLElement).getByText('帮我写'))
    fireEvent.click(within(card as HTMLElement).getByText('生成'))
    await waitFor(() => expect(window.api.ai.chat).toHaveBeenCalledTimes(1))
    await completeStream(lastRequestId(), ['新增内容'])
    // 生成期间用户又改了字段 → 追加以最新值为基准
    act(() => {
      useCharacterCreatorStore.getState().updateDraft({ description: '用户最新输入' })
    })
    fireEvent.click(within(card as HTMLElement).getByText('追加'))
    expect(useCharacterCreatorStore.getState().draft.description).toBe('用户最新输入\n\n新增内容')
  })

  it('三选：「放弃」丢弃结果，字段保持原样且预览卡消失', async () => {
    useCharacterCreatorStore.getState().updateDraft({ description: '原有内容' })
    render(<ConceptStep />)
    const card = screen.getByText('角色描述').closest('.field-card')!
    fireEvent.click(within(card as HTMLElement).getByText('帮我写'))
    fireEvent.click(within(card as HTMLElement).getByText('生成'))
    await waitFor(() => expect(window.api.ai.chat).toHaveBeenCalledTimes(1))
    await completeStream(lastRequestId(), ['不该出现'])
    fireEvent.click(within(card as HTMLElement).getByText('放弃'))
    expect(useCharacterCreatorStore.getState().draft.description).toBe('原有内容')
    expect(within(card as HTMLElement).queryByText(/AI 已生成/)).not.toBeInTheDocument()
    expect(useCharacterCreatorStore.getState().pendingGeneration).toBeNull()
  })

  it('标签生成：「追加」合并去重，「替换」整体替换', async () => {
    useCharacterCreatorStore.getState().updateDraft({ tags: ['黑客'] })
    render(<ConceptStep />)
    const card = screen.getByText('标签').closest('.field-card')!
    fireEvent.click(within(card as HTMLElement).getByText('帮我写'))
    fireEvent.click(within(card as HTMLElement).getByText('生成'))
    await waitFor(() => expect(window.api.ai.chat).toHaveBeenCalledTimes(1))
    await completeStream(lastRequestId(), ['黑客、赛博朋克'])
    fireEvent.click(within(card as HTMLElement).getByText('追加'))
    expect(useCharacterCreatorStore.getState().draft.tags).toEqual(['黑客', '赛博朋克'])
    // 再生成一次走「替换」
    fireEvent.click(within(card as HTMLElement).getByText('帮我写'))
    fireEvent.click(within(card as HTMLElement).getByText('生成'))
    await waitFor(() => expect(window.api.ai.chat).toHaveBeenCalledTimes(2))
    await completeStream(lastRequestId(), ['御姐'])
    fireEvent.click(within(card as HTMLElement).getByText('替换'))
    expect(useCharacterCreatorStore.getState().draft.tags).toEqual(['御姐'])
  })

  it('开场白生成：「追加」为新备选开场白，不动当前文本', async () => {
    useCharacterCreatorStore.getState().updateDraft({ firstMessage: '主消息' })
    render(<ConceptStep />)
    const card = screen.getByText('首条消息').closest('.field-card')!
    fireEvent.click(within(card as HTMLElement).getByText('帮我写'))
    fireEvent.click(within(card as HTMLElement).getByText('生成'))
    await waitFor(() => expect(window.api.ai.chat).toHaveBeenCalledTimes(1))
    await completeStream(lastRequestId(), ['*翻窗而入* "久等了。"'])
    fireEvent.click(within(card as HTMLElement).getByText('追加'))
    const s = useCharacterCreatorStore.getState()
    expect(s.draft.firstMessage).toBe('主消息') // 当前文本不动
    expect(s.draft.alternateGreetings).toEqual(['*翻窗而入* "久等了。"']) // 追加为新备选项
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

  it('帮我写面板支持 Ctrl+Enter 快速生成（UEX-P2-07：完成后进待确认）', async () => {
    render(<ConceptStep />)
    const card = screen.getByText('角色描述').closest('.field-card')!
    fireEvent.click(within(card as HTMLElement).getByText('帮我写'))
    const input = within(card as HTMLElement).getByPlaceholderText(/告诉 AI 你想要什么/)
    fireEvent.change(input, { target: { value: '银发女黑客' } })
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
    await waitFor(() => expect(window.api.ai.chat).toHaveBeenCalledTimes(1))
    await completeStream(lastRequestId(), ['银色短发，黑客装扮'])
    expect(useCharacterCreatorStore.getState().draft.description).toBe('') // 不直接覆盖
    fireEvent.click(within(card as HTMLElement).getByText('替换'))
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

  it('主首条消息的帮我写面板：生成进待确认，替换后写入 firstMessage', async () => {
    render(<ConceptStep />)
    const card = screen.getByText('首条消息').closest('.field-card')!
    fireEvent.click(within(card as HTMLElement).getByText('帮我写'))
    const input = within(card as HTMLElement).getByPlaceholderText(/告诉 AI 你想要什么/)
    fireEvent.change(input, { target: { value: '要冷淡一点' } })
    fireEvent.click(within(card as HTMLElement).getByText('生成并修改'))
    await waitFor(() => expect(window.api.ai.chat).toHaveBeenCalledTimes(1))
    await completeStream(lastRequestId(), ['*抬眼* "说正事。"'])
    expect(useCharacterCreatorStore.getState().draft.firstMessage).toBe('') // UEX-P2-07：不直接覆盖
    fireEvent.click(within(card as HTMLElement).getByText('替换'))
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

  it('AI 扩展：输入概念并触发 ai.chat', async () => {
    render(<ConceptStep />)
    const conceptInput = screen.getByPlaceholderText(/赛博朋克世界的女黑客/)
    fireEvent.change(conceptInput, { target: { value: '古风剑客' } })
    fireEvent.click(screen.getByText('AI 扩展'))
    await waitFor(() => expect(window.api.ai.chat).toHaveBeenCalledTimes(1))
    const params = (window.api.ai.chat as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(params.messages[1].content).toBe('古风剑客')
    // 触发完成 → 填充
    await completeStream(lastRequestId(), ['{"name":"剑客","tags":["古风"]}'])
    expect(useCharacterCreatorStore.getState().draft.name).toBe('剑客')
  })
})
