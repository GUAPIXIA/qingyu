// ===================== 共享常量（单聊 / 群聊 store 通用） =====================

/** 流式更新节流时间（毫秒）- 避免每个 chunk 都触发重渲染 */
export const STREAM_THROTTLE_MS = 50

/** 默认世界书扫描深度（最近 N 条消息） */
export const DEFAULT_LOREBOOK_SCAN_DEPTH = 10

/** 语义触发扫描文本的 token 上限（大上下文下扩大语义判断范围） */
export const SEMANTIC_SCAN_MAX_TOKENS = 4000

/** 世界书 token 预算占上下文预算（budgetBase）的默认比例 */
export const DEFAULT_LOREBOOK_RATIO = 0.3

/** 启发式 token 估算的安全余量系数（吸收估算误差，替代精确计数） */
export const TOKEN_BUDGET_SAFETY = 0.95

/** 输出预留兜底值（preset.maxTokens 缺省时） */
export const DEFAULT_RESERVED_OUTPUT = 1024

/** 图片消息的 token 估算（每张） */
export const IMAGE_TOKEN_ESTIMATE = 200

/** 长记忆摘要默认取最近消息数 */
export const MEMORY_SUMMARY_RECENT = 20

/** 长记忆摘要最少消息数 */
export const MEMORY_SUMMARY_MIN = 4

/**
 * 流式空闲超时：超过该时长未收到任何 chunk 则视为卡死并中断。
 * 每次收到 chunk 都会续期（空闲计时），对慢推理模型也公平。
 */
export const STREAM_IDLE_TIMEOUT_MS = 60 * 1000
