# ADR-008: Canonical JSON 采用 RFC 8785 兼容字节规范；counter 为 UInt64 十进制字符串

- 状态：已接受
- 日期：2026-09-16
- 决策阶段：阶段 0

## 背景

`contentHash`、AAD、签名与跨语言 fixture 要求字节级稳定序列化。JS `number`、JVM `Long`、SQLite INTEGER 对 64 位计数与部分数值有损或平台差异。RFC 8785（JCS）定义了确定性 JSON 序列化。

## 选择

- 跨端 hash/签名输入的规范 JSON 采用 **RFC 8785 兼容** 规则（对象键 UTF-16 码元序、无多余空白、数字规范形式）；实现差异必须以共享 golden 字节钉死。
- 版本向量与 dot 的 counter：在 JSON **线格式与持久化** 中一律为无前导零的十进制字符串；比较与递增用无符号 128 位或等价安全实现，不经有损 `number`/`Long` 冲突路径。
- 时间戳 `updatedAt` 仅用于显示与稳定排序，不进因果比较。

## 否决方案

1. **`JSON.stringify`/`JSONObject.toString` 默认输出直接 hash**：否决。键序、转义与数字格式不保证跨语言一致。
2. **counter 用 JS number 或 SQLite INTEGER**：否决。>2^53-1 或符号扩展会导致静默错误。
3. **自发明 canonical 而不锚定 RFC 8785**：否决。实现分叉成本高；本项目采用 RFC 8785 兼容 + 边界 golden。

## 后果

- 阶段 0/1 提供 RFC 8785 边界与 version-vector 字符串 golden。
- 第三方库选择必须通过兼容性测试，不能只信 README。

## 重新评估条件

- 需要支持 RFC 8785 明确排除的数据类型且产品强制要求时；须更新契约版本而非静默改变字节。
