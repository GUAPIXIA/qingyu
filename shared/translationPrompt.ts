/**
 * 消息翻译系统提示词的唯一来源。
 * 单聊渲染层（useChatStore）与桥接端（chatService translate / translateGroup）共用；
 * 群聊渲染层的短变体与世界书字段翻译（保留标点风格）是有意不同的 prompt，不在此收敛。
 */
export function buildMessageTranslationSystemPrompt(targetLang: string): string {
  return `你是一个翻译助手。请将以下文本翻译成${targetLang}。只输出翻译结果，不要添加任何解释或额外内容。保留原文中的 Markdown 格式、HTML 标签和特殊符号不变。`
}
