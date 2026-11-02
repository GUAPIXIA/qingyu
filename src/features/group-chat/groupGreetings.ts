/**
 * 群聊开场白来源解析（与单聊开场白口径对齐）。
 *
 * 优先级：
 * 1. `groupOnlyGreetings`（角色卡为群聊单独维护的开场白，非空时使用，保持既有行为）；
 * 2. 否则回退到单聊同口径：`firstMessage` + `alternateGreetings`（均优先译文）。
 *
 * 单聊选择器已支持备选开场白（含译文），群聊此前只取 firstMessage，
 * 导致“只有备选开场白”的角色在群聊里没有开场白可选。
 */
import type { Character } from '../../../shared/types'

/** 解析某成员在群聊开场白选择器中可用的开场白文本（已按群聊既有口径取译文）。 */
export function resolveGroupGreetingOptions(character: Character): string[] {
  const groupOnly = (character.groupOnlyGreetings ?? []).filter((greeting) => !!greeting?.trim())
  if (groupOnly.length > 0) return groupOnly
  const first = character.translatedContent?.firstMessage ?? character.firstMessage
  const alternates = (character.alternateGreetings ?? []).map(
    (greeting, index) => character.translatedContent?.alternateGreetings?.[index] || greeting,
  )
  return [first, ...alternates].filter((greeting): greeting is string => !!greeting?.trim())
}

/** 该成员是否有任何可用于群聊的开场白（供页面判断是否自动弹选择器）。 */
export function hasGroupGreeting(character: Character | undefined): boolean {
  return !!character && resolveGroupGreetingOptions(character).length > 0
}
