# 世界书触发 Golden

此目录冻结阶段 0 时 `triggerAndFitLorebooks()` 的可观察领域行为，用于后续拆分 runtime compiler、trigger engine、ranking、budget 和 insertion renderer 时做差分回归。

Golden 输出有意排除：

- `createdAt`；
- live 模式概率随机数；
- tokenizer 版本可能影响的逐条 token 数；
- 压缩任务中的非领域缓存时间。

它保留触发集合、递归来源、匹配词、语义来源、插入位置、预算丢弃和主要诊断原因。除非确认产品行为需要变化，否则重构不得直接更新 expected。

