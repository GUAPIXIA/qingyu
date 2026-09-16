// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { normalizeImportedLorebook } from '../lorebookImport'

describe('normalizeImportedLorebook', () => {
  it('将 tokenBudget = 0 归一化为未设置', () => {
    const result = normalizeImportedLorebook({
      name: '零预算世界书',
      token_budget: 0,
      entries: [],
    }, { id: 'zero-budget', fallbackName: '回退名称', sourceKind: 'sillytavern' })

    expect(result.tokenBudget).toBeUndefined()
  })

  it('归一化 SillyTavern 世界书对象与现代数字位置', () => {
    const result = normalizeImportedLorebook({
      name: 'ST 世界书',
      scan_depth: 0,
      recursive_scanning: false,
      entries: {
        10: {
          uid: 10,
          key: ['王城', '首都'],
          content: '王城是帝国首都。',
          position: 4,
          depth: 2,
          order: 250,
          probability: 80,
          disable: false,
          constant: true,
          vectorized: false,
          keysecondary: ['帝国', '皇帝'],
          selective: true,
          selectiveLogic: 3,
          caseSensitive: true,
          matchWholeWords: false,
          excludeRecursion: true,
          preventRecursion: true,
          delayUntilRecursion: 2,
          scanDepth: 1,
          group: '王族, 地点',
          groupOverride: true,
          groupWeight: 250,
          useGroupScoring: true,
          characterFilter: { isExclude: false, names: ['Alice'], tags: ['royal'] },
          triggers: ['normal', 'continue'],
          sticky: 3,
          cooldown: 2,
          delay: 1,
        },
        11: {
          uid: 11,
          key: [],
          content: '与当前对话语义相关时出现。',
          position: 2,
          disable: false,
          vectorized: true,
        },
      },
    }, { id: 'st-book', fallbackName: '回退名称', sourceKind: 'sillytavern' })

    expect(result).toMatchObject({
      id: 'st-book', name: 'ST 世界书', scanDepth: 0, enabled: true, recursiveScanning: false,
    })
    expect(result.entries[0]).toMatchObject({
      id: '10',
      keywords: ['王城', '首都'],
      position: 'at_depth',
      depth: 2,
      order: 250,
      probability: 80,
      enabled: true,
      priority: 'always',
      matchMode: 'keyword',
      secondaryKeywords: ['帝国', '皇帝'],
      selectiveLogic: 'and_all',
      caseSensitive: true,
      matchWholeWords: false,
      excludeRecursion: true,
      preventRecursion: true,
      delayUntilRecursion: 2,
      scanDepth: 1,
      inclusionGroups: ['王族', '地点'],
      inclusionGroupPrioritized: true,
      inclusionGroupWeight: 250,
      useGroupScoring: true,
      characterFilter: { exclude: false, names: ['Alice'], tags: ['royal'] },
      generationTriggers: ['normal', 'continue'],
      sticky: 3,
      cooldown: 2,
      delay: 1,
    })
    expect(result.entries[1]).toMatchObject({
      id: '11',
      keywords: [],
      position: 'at_end',
      matchMode: 'semantic',
    })
  })

  it('归一化 CCv2/CCv3 character_book 字段', () => {
    const result = normalizeImportedLorebook({
      name: '角色内嵌书',
      scan_depth: 6,
      entries: [{
        id: 'capital',
        keys: ['王城'],
        secondary_keys: ['帝国'],
        content: '王城设定',
        enabled: true,
        insertion_order: 42,
        position: 'after_char',
        constant: false,
        use_regex: true,
        selective: true,
        extensions: {
          position: 4,
          depth: 3,
          probability: 65,
          use_probability: true,
          vectorized: true,
          exclude_recursion: true,
          prevent_recursion: true,
          case_sensitive: false,
          match_whole_words: false,
          ignore_budget: true,
          scan_depth: 2,
          delay_until_recursion: true,
          group: 'capital',
          group_override: true,
          group_weight: 180,
          use_group_scoring: true,
          character_filter: { isExclude: true, names: ['Bob'], tags: ['blocked'] },
          triggers: ['continue'],
          sticky: 4,
          cooldown: 3,
          delay: 2,
        },
      }],
    }, { id: 'embedded-book', fallbackName: '角色的世界书', sourceKind: 'character_book' })

    expect(result.entries[0]).toMatchObject({
      id: 'capital',
      keywords: ['王城'],
      content: '王城设定',
      enabled: true,
      order: 42,
      position: 'at_depth',
      depth: 3,
      probability: 65,
      useRegex: true,
      matchMode: 'both',
      secondaryKeywords: ['帝国'],
      selectiveLogic: 'and_any',
      caseSensitive: false,
      matchWholeWords: false,
      excludeRecursion: true,
      preventRecursion: true,
      ignoreBudget: true,
      scanDepth: 2,
      delayUntilRecursion: 1,
      inclusionGroups: ['capital'],
      inclusionGroupPrioritized: true,
      inclusionGroupWeight: 180,
      useGroupScoring: true,
      characterFilter: { exclude: true, names: ['Bob'], tags: ['blocked'] },
      generationTriggers: ['continue'],
      sticky: 4,
      cooldown: 3,
      delay: 2,
    })
  })

  it('解包 lorebook_v3 并保留标准字段', () => {
    const result = normalizeImportedLorebook({
      spec: 'lorebook_v3',
      data: {
        name: 'V3 世界书',
        description: '说明',
        scan_depth: 8,
        entries: [{
          id: 7,
          keys: ['遗迹'],
          content: '遗迹位于北方。',
          enabled: true,
          insertion_order: 90,
          position: 'before_char',
          constant: true,
          use_regex: false,
        }],
      },
    }, { id: 'v3-book', fallbackName: '回退名称', sourceKind: 'character_book' })

    expect(result).toMatchObject({
      id: 'v3-book',
      name: 'V3 世界书',
      description: '说明',
      scanDepth: 8,
    })
    expect(result.entries[0]).toMatchObject({
      id: '7',
      keywords: ['遗迹'],
      order: 90,
      position: 'before_char',
      priority: 'always',
    })
  })

  it('轻语原生格式经导入不会丢失运行时字段', () => {
    const result = normalizeImportedLorebook({
      id: 'native-source',
      name: '原生世界书',
      description: '原生说明',
      enabled: false,
      scanDepth: 3,
      entries: [{
        id: 'native-entry',
        keywords: ['天气'],
        content: '天气设定',
        position: 'at_depth',
        depth: 1,
        order: 5,
        probability: 75,
        enabled: false,
        useRegex: true,
        regexFlags: 'iu',
        matchMode: 'both',
        priority: 'detail',
        summary: '天气摘要',
      }],
    }, { id: 'safe-native-id', fallbackName: '回退名称', sourceKind: 'native' })

    expect(result).toEqual({
      id: 'safe-native-id',
      name: '原生世界书',
      description: '原生说明',
      enabled: false,
      scanDepth: 3,
      entries: [{
        id: 'native-entry',
        keywords: ['天气'],
        content: '天气设定',
        position: 'at_depth',
        depth: 1,
        order: 5,
        probability: 75,
        enabled: false,
        useRegex: true,
        regexFlags: 'iu',
        matchMode: 'both',
        priority: 'detail',
        summary: '天气摘要',
      }],
    })
  })

  it('ST at_depth 条目缺省 depth 为 4，并导入字符串或数字 role 字段', () => {
    const result = normalizeImportedLorebook({
      entries: [{
        uid: 1,
        key: ['王城'],
        content: '王城设定',
        position: 4,
        role: 'user',
      }, {
        uid: 2,
        key: ['首都'],
        content: '首都设定',
        position: 4,
        depth: 1,
        role: 'assistant',
      }, {
        uid: 3,
        key: ['边境'],
        content: '边境设定',
        position: 0,
      }, {
        uid: 4,
        key: ['港口'],
        content: '港口设定',
        position: 4,
        role: 1,
      }, {
        uid: 5,
        key: ['山谷'],
        content: '山谷设定',
        position: 4,
        role: 2,
      }],
    }, { id: 'depth-default', fallbackName: '回退名称', sourceKind: 'sillytavern' })

    expect(result.entries[0]).toMatchObject({ position: 'at_depth', depth: 4, role: 'user' })
    expect(result.entries[1]).toMatchObject({ position: 'at_depth', depth: 1, role: 'assistant' })
    // 非 at_depth 位置：depth 保持 0，role 不导入
    expect(result.entries[2]).toMatchObject({ position: 'before_char' })
    expect(result.entries[2].role).toBeUndefined()
    expect(result.entries[3]).toMatchObject({ position: 'at_depth', role: 'user' })
    expect(result.entries[4]).toMatchObject({ position: 'at_depth', role: 'assistant' })
  })

  it('非法 role 值不导入，at_depth 之外的 role 忽略', () => {
    const result = normalizeImportedLorebook({
      entries: [{
        uid: 1,
        key: ['王城'],
        content: '王城设定',
        position: 4,
        role: 'invalid_role',
      }, {
        uid: 2,
        key: ['首都'],
        content: '首都设定',
        position: 1,
        role: 'user',
      }],
    }, { id: 'role-check', fallbackName: '回退名称', sourceKind: 'sillytavern' })

    expect(result.entries[0].role).toBeUndefined()
    expect(result.entries[1].role).toBeUndefined()
  })

  it('原生条目缺省 depth 保持 0（不受 ST 缺省 4 影响）', () => {
    const result = normalizeImportedLorebook({
      entries: [{
        keywords: ['天气'],
        content: '天气设定',
        position: 'at_depth',
      }],
    }, { id: 'native-depth', fallbackName: '回退名称', sourceKind: 'native' })

    expect(result.entries[0]).toMatchObject({ position: 'at_depth', depth: 0 })
  })
})
