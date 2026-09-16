# ADR-001: 保留原生 Compose，不改用 WebView/Capacitor

- 状态：已接受
- 日期：2026-09-16
- 决策阶段：阶段 0

## 背景

Android 目标是脱离 PC 伴侣模式成为完整客户端。若用 WebView/Capacitor 包 PC 的 React 页，可减少 UI 重写成本，但会引入运行时体积、权限、离线存储、本地 TTS/Keystore/SAF 集成与长期双端 UI 同步负担。现网 Android 已是 Kotlin + Compose + Room。

## 选择

继续以原生 Compose 为 Android UI 与应用壳；平台能力（Keystore、SAF、系统 TTS、通知、权限）用原生 API。跨端一致通过语言无关契约与等价业务规则保证，不通过共享 Web 渲染层保证。

## 否决方案

1. **WebView/Capacitor 包 PC 页**：否决。离线与系统集成成本高，打包与崩溃面变差，难以满足“PC 关闭仍完整可用”。
2. **Flutter/React Native 全重写**：否决。丢弃已有 Compose/Room 资产，迁移风险大于收益。

## 后果

- Android 功能对齐必须逐能力验收（能力矩阵），不能靠“同一套前端”自动对齐。
- 需维护 TS/Kotlin 双实现与共享 fixtures（ADR-002）。

## 重新评估条件

- 产品明确要求 Android 与 PC 逐像素同构，且接受 WebView 离线/权限缺陷；或 Compose 维护成本长期不可接受。
