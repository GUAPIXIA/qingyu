# 世界书格式 Fixture

此目录是“世界书重构与多格式兼容方案”阶段 0 的输入基线，不是格式适配器实现。

每个 P0 格式族固定四类样本：

- `minimal.json`：规范允许且能被当前导入器接收的最小结构；
- `full.json`：覆盖当前已知映射字段；
- `invalid.json`：结构可解析，但不能作为有效世界书导入；
- `unknown-extensions.json`：携带当前实现不认识的扩展字段，用于冻结现阶段的丢失行为，并为阶段 2 的未知字段保留测试提供输入。

来源、格式版本、采集时间和预期结果记录在 `catalog.json`。`spec-derived` 样本依据公开规范重新构造，不包含第三方角色设定或个人数据；`project-regression` 样本来自轻语当前类型与既有测试。

阶段 0 只记录现状。`unknownFieldPolicy: currently_dropped` 不是目标行为，而是提醒后续适配器重构必须把该预期改为 namespaced preservation。

