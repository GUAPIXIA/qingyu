import { describe, expect, it } from 'vitest'
import { buildGroupRosterIntro, buildGroupTurnRulesPrompt } from '../groupChatPrompt'

describe('groupChatPrompt（桌面/桥接共用公共段）', () => {
  it('成员概览：序号、截断 80 字描述与用户在场声明', () => {
    const intro = buildGroupRosterIntro(
      '夜航船',
      [
        { name: '苏晚', description: '长'.repeat(120) },
        { name: '阿澈' },
      ],
      '旅行者',
    )
    expect(intro).toBe(
      '你正在参与一个群聊「夜航船」。本群聊中共有 2 个角色参与对话：\n' +
      '1. 【苏晚】 - ' + '长'.repeat(80) + '\n' +
      '2. 【阿澈】\n' +
      '\n用户「旅行者」也在群聊中。\n',
    )
  })

  it('点名/轮询规则逐字输出；free 返回空串由调用方自带', () => {
    expect(buildGroupTurnRulesPrompt('mention')).toContain('只有被点名的角色才需要回复')
    expect(buildGroupTurnRulesPrompt('mention')).toContain('对白必须是该角色自己的第一人称')
    expect(buildGroupTurnRulesPrompt('mention')).toContain('动作/神态可用第三人称叙述')
    expect(buildGroupTurnRulesPrompt('polling')).toContain('每次只轮到一位角色发言')
    expect(buildGroupTurnRulesPrompt('polling')).toContain('对白必须是该角色自己的第一人称')
    expect(buildGroupTurnRulesPrompt('polling')).toContain('动作/神态可用第三人称叙述')
    expect(buildGroupTurnRulesPrompt('free')).toBe('')
  })

  it('不得再出现歧义的「以该角色的第一人称视角发言」旧措辞', () => {
    expect(buildGroupTurnRulesPrompt('mention')).not.toContain('第一人称视角发言')
    expect(buildGroupTurnRulesPrompt('polling')).not.toContain('第一人称视角回复')
  })
})
