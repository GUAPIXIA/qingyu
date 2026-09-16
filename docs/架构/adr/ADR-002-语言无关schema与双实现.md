# ADR-002: 语言无关 schema + 双实现，不直接运行 TypeScript 核心

- 状态：已接受
- 日期：2026-09-16
- 决策阶段：阶段 0

## 背景

`shared/chat-core` 已有较多确定性对话逻辑与契约测试，可作行为基准。但 Android 无法直接、可靠地运行完整 TS 业务内核（原生侧性能、调试、进程模型、依赖体积）。

## 选择

- 以 JSON Schema / OpenAPI / `shared/fixtures/cross-platform/` 定义语言无关契约。
- PC 保留 TypeScript Domain Core；Android 以 Kotlin 等价实现。
- 用同一 fixture 驱动双端一致性测试；差异必须改契约或双端同时修复，不得静默漂移。

## 否决方案

1. **JS 引擎/QuickJS 嵌入跑 TS 核心**：否决。调试困难、与 Room/主线程集成脆弱、审计面大。
2. **仅以 Android 为权威、PC 向它对齐**：否决。PC 已是成熟实现与测试资产中心。

## 后果

- 阶段 0/1 必须产出并冻结 golden fixtures。
- 每个跨端确定性算法都需要双实现测试；工程量高于单端复用。

## 重新评估条件

- 出现一等公民、可审计、可维护的跨语言核心运行时（非实验性嵌入），且能证明与 Room/本地生成栈集成成本低于双实现。
