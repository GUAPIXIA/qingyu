import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import type { Character } from '../../../../shared/types'
import { useSettingsStore } from '../../../store/useSettingsStore'
import { getDefaultSettings } from '../../../../shared/defaults'
import { CharacterEditor } from '../CharacterEditor'
vi.mock('../editor/IdentitySection', () => ({ IdentitySection: () => null }))
vi.mock('../editor/AdvancedSection', () => ({ AdvancedSection: ({ form, update, handleTranslateField }: { form: Character; update: (p: Partial<Character>) => void; handleTranslateField: (key: string) => void }) => <>
  <input aria-label="描述" value={form.description} onChange={event => update({ description: event.target.value })} />
  <button onClick={() => handleTranslateField('description')}>翻译描述</button>
  <span data-testid="translation">{form.translatedContent?.description}</span>
</> }))
const character = (id: string): Character => ({ id, name: id, description: 'source', personality: '', scenario: '', firstMessage: '', exampleDialog: '', avatar: '', tags: [], alternateGreetings: [], lorebookId: null, creator: '', createdAt: 1, updatedAt: 1 })
beforeEach(() => {
  vi.clearAllMocks()
  useSettingsStore.setState({ settings: { ...getDefaultSettings(), activeProfileId: 'p1', connectionProfiles: [{ id: 'p1', name: 'test', provider: 'openai', baseUrl: 'https://example.invalid', apiKey: 'fixture', model: 'gpt-4o', maxContext: 8192 }] }, credentials: {} })
})
describe('角色卡编辑辅助提交', () => {
  it.each(['未编辑', '改后改回', '切换角色'])('%s时仅接受原对象和版本的译文', async action => {
    let chunk: Parameters<typeof window.api.ai.onChunk>[0] = () => {}
    let done: Parameters<typeof window.api.ai.onComplete>[0] = () => {}
    vi.mocked(window.api.ai.onChunk).mockImplementation(cb => { chunk = cb; return vi.fn() })
    vi.mocked(window.api.ai.onComplete).mockImplementation(cb => { done = cb; return vi.fn() })
    const { rerender } = render(<CharacterEditor character={character('c1')} onSave={vi.fn()} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '翻译描述' }))
    await waitFor(() => expect(window.api.ai.chat).toHaveBeenCalledOnce())
    const requestId = vi.mocked(window.api.ai.chat).mock.calls[0][0].requestId
    if (action === '改后改回') {
      fireEvent.change(screen.getByLabelText('描述'), { target: { value: 'new' } })
      fireEvent.change(screen.getByLabelText('描述'), { target: { value: 'source' } })
    }
    if (action === '切换角色') rerender(<CharacterEditor character={character('c2')} onSave={vi.fn()} onClose={vi.fn()} />)
    await act(async () => { chunk({ requestId, text: '旧译文' }); done({ requestId, finishReason: 'stop' }) })
    expect(screen.getByTestId('translation')).toHaveTextContent(action === '未编辑' ? '旧译文' : '')
    if (action === '改后改回') expect(screen.getByDisplayValue('旧译文')).toBeInTheDocument()
    if (action === '切换角色') expect(window.api.ai.cancelChat).toHaveBeenCalledWith(requestId)
  })
})
