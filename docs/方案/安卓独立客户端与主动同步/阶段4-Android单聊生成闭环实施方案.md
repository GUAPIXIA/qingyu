# 阶段 4：Android 单聊生成闭环实施方案

> 状态：⚠️ 待处理  
> 前置：阶段 1、阶段 3；使用阶段 0/1 冻结的 PC 行为 fixture，并跟踪阶段 2 Repository 适配变化。  
> 目标：Android 不依赖 PC 完成单聊的上下文构建、模型生成、消息持久化、记忆与全部核心消息操作。

## 1. 设计原则

- 先复用行为，不复制 PC 的 UI/store 结构。
- 所有确定性算法以 `shared/chat-core` fixture 为 oracle，在 Kotlin 中实现等价版本。
- 生成任务独立于 Compose 生命周期；ViewModel 只订阅任务状态。
- 用户消息、生成任务、流式草稿和最终消息具有明确事务边界。
- 未验证完成结果不得提前保存为成功消息。

## 2. 任务拆分

### S4-01 Kotlin Chat Core

按依赖顺序实现并与 TypeScript golden 对齐：

1. variables/macros、regex 输入输出处理；
2. prompt converters、角色与人设提示；
3. lorebook 关键词检索与位置渲染；
4. memory window、历史裁剪和降级；
5. context candidates/allocator、token 预算；
6. message post-process、thought、continuation seam；
7. response policy、narrative mode、dialogue directions；
8. generation termination/finalizer。

不能依靠翻译 TS 源码后人工目测。每个模块必须读取相同输入 fixture，并比较结构化输出；提示词文本需要逐字节或明确的规范化后相等。

### S4-02 Token 计数策略

- UI 即时预算使用与 PC 同口径的启发式估算。
- 支持的 tokenizer 可使用移动端实现；不支持时明确标记 estimated。
- tokenizer 下载属于可重建资源，不同步。
- 超出上下文前必须在本地阻断或降级，不能只依赖供应商报错。

### S4-03 GenerationTask 状态机

状态固定为：

```text
queued -> preparing -> streaming -> finalizing -> completed
                                  -> cancelled
                                  -> failed(retryable/non_retryable)
```

- taskId/requestId 在重试语义上分离；同一次网络重试保持 requestId。
- 草稿 chunk 写入节流缓存，完成时一次性生成 final message。
- 应用进后台时默认继续当前请求，但遵守 Android 前台服务/通知政策；用户可关闭。
- 进程死亡后未完成任务标记 interrupted，不自动重发，以免重复计费。

### S4-04 单聊用例

实现并逐项验收：

- 创建/重命名/删除会话；
- 发送、停止、失败重试；
- 编辑/删除/清空消息；
- regenerate、swipe、continue、input continue；
- 从消息创建分支；
- 翻译、引用、复制、朗读；
- 会话级预设、人设、世界书和叙事模式；
- 会话导出 Markdown/JSON；
- 上下文用量与本轮诊断。

所有操作必须写 Repository 并生成 journal；UI 中的乐观状态失败时回滚。

### S4-05 记忆闭环

- 手动摘要、自动摘要间隔、事实提取、当前状态、历史记录。
- 使用 CAS/expectedVersion 防止生成期间用户编辑导致旧摘要覆盖新历史。
- 记忆请求与正常聊天使用独立 task type 和用量记录。
- 文本历史变化时按 PC 规则使派生记忆失效。
- embedding 不可用时，事实仍保存，语义检索降级到非向量路径。

### S4-06 UI 接管

现有 ChatScreen 从 Remote Repository 切到 Local Repository：

- 长列表稳定 key、分页与 scroll anchor 不回退；
- streaming 草稿不导致整表重组；
- 本地生成任务状态与模型连接状态有清晰标签；界面不得出现旧远程运行模式或回退入口；
- 快捷设置面板只写本地设置；
- 错误提示显示可行动作，不暴露供应商原始敏感响应。

## 3. 一致性测试

至少覆盖：

- 同一角色、预设、世界书、记忆、历史和设置，PC/Android 生成的请求消息数组一致。
- 所有宏、世界书位置、token 裁剪、历史降级和 post-process golden 一致。
- 空输出、只有 thought、length、content filter、取消、网络断开、供应商格式错误得到同一终局分类。
- 编辑历史后记忆失效，旧自动摘要不能覆盖新版本。
- 生成中切换页面、旋转、进后台、杀进程不重复保存/发送。
- 10k 消息会话打开、分页和流式性能相对阶段 0 基线回退不得超过 20%。

## 4. 实机验收脚本

每个支持的 provider 至少完成：连接测试、普通流式、长回复、停止、重试、切后台、网络切换、错误密钥和限流。测试使用专用低额度密钥，不写入仓库或报告；报告只记 endpoint 指纹和模型名。

## 5. 完成定义

关闭 PC 和 Relay 后，Android 能从创建会话到连续多轮聊天、编辑、重生成、记忆和导出完整运行；对照 fixture 无未解释差异，代码与导航中不存在旧伴侣模式回退入口。
