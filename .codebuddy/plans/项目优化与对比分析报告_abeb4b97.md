---
name: 项目优化与对比分析报告
overview: 对"轻语"项目（d:\Code\酒馆）进行全面检查，并与原版 SillyTavern（d:\Code\SillyTavern-Launcher\SillyTavern）对比，产出一份结构化的中文 Markdown 报告，包含架构分析、代码质量与优化点、功能差距三大维度，落到项目根目录的 MD 文件中。
todos:
  - id: write-internal-analysis
    content: 撰写轻语项目内部优化分析章节，覆盖大文件清单（useChatStore.ts:2145行等10+文件）、状态管理耦合（7个store分析）、性能隐患（流式节流、虚拟滚动、向量检索）、错误处理模式、测试覆盖（19个测试文件评估）、CI/CD现状（.github/workflows/ci.yml lint 152错误 continue-on-error）
    status: completed
  - id: write-st-comparison
    content: 撰写与 SillyTavern 的功能差距对比章节，覆盖AI后端（7 vs 40+）、向量系统（JSON方案 vs 9提供者+vectra）、插件系统、i18n（0 vs 17语言）、多用户/SSO、安全机制、角色卡格式、图像/TTS后端、跨平台等维度，区分"桌面端不适用"与"真实缺失"
    status: completed
    dependencies:
      - write-internal-analysis
  - id: write-recommendations
    content: 撰写具体可执行优化建议与优先级路线图章节，按高/中/低分级给出每个优化项的具体文件路径、修改方向和预期收益
    status: completed
    dependencies:
      - write-st-comparison
  - id: assemble-output
    content: 将三个章节组装为完整的 Markdown 文件，写入 d:\Code\酒馆\项目优化与对比分析.md，包含概览速查表、目录索引和格式校验
    status: completed
    dependencies:
      - write-recommendations
---

## 用户需求

用户要求对"轻语 QingYu"项目（d:\Code\酒馆）进行全面检查，找出优化点，并与原版 SillyTavern 项目（d:\Code\SillyTavern-Launcher\SillyTavern）进行对比分析，最终输出一份 Markdown 格式的分析报告文件。

## 产品概述

输出一份结构化的 Markdown 文档，包含两大核心内容：

1. 轻语项目自身的架构与代码质量优化点（大文件拆分、状态管理耦合、性能隐患、测试覆盖、工程化等）
2. 轻语相比 SillyTavern 的功能差距清单（AI 后端数量、向量系统、插件生态、i18n、多用户、安全机制、角色卡格式、图像/TTS 后端等）

所有结论均带具体文件路径与行号引用，便于用户直接定位修改。

## 核心内容

- 轻语内部优化点：超大文件清单（useChatStore.ts 2145行、useGroupChatStore.ts 2007行、ai.ts 1198行等）、状态管理耦合分析、错误处理与性能隐患、测试覆盖率评估、CI/CD 与 lint 现状
- 与 SillyTavern 的功能差距：AI 后端对比（7 vs 40+）、向量系统对比（JSON 方案 vs 9个向量提供者 + vectra）、插件系统缺失、i18n 缺失（0 vs 17种语言）、多用户缺失、安全机制差距、角色卡格式覆盖、图像/TTS 后端覆盖、跨平台缺失
- 具体可执行优化建议与优先级路线图

## 技术方案

### 分析方法论

基于两次 code-explorer 子代理对两个项目的深度扫描结果（轻语项目 65 次工具调用、SillyTavern 项目 104 次工具调用），结合主代理对关键文件的直接验证读取，形成交叉确认的发现清单。

### 输出文件

- 路径：`d:\Code\酒馆\项目优化与对比分析.md`
- 格式：标准 Markdown，包含表格、代码引用、分级标题

### 文档结构

1. 概览与项目信息速查表
2. 轻语内部架构与工程优化点（含大文件清单、状态管理、性能、测试、CI/CD）
3. 与 SillyTavern 的功能差距清单（分高/中/低优先级）
4. 具体可执行优化建议（带文件路径与行号）
5. 结论与优先级路线图

### 已验证的关键数据基线

**轻语项目大文件清单：**

| 文件 | 行数 | 问题 |
| --- | --- | --- |
| `src/store/useChatStore.ts` | 2145 | 单体 God Store |
| `src/store/useGroupChatStore.ts` | 2007 | 单体 God Store |
| `electron/services/ai.ts` | 1198 | 所有适配器集中 |
| `src/components/character/CharacterEditor.tsx` | ~1170 | 超大组件 |
| `src/pages/SettingsPage.tsx` | ~1100 | 超大页面 |
| `src/components/chat/ChatInput.tsx` | ~905 | 超大组件 |
| `src/pages/GroupChatPage.tsx` | ~920 | 超大页面 |
| `src/pages/LorebookPage.tsx` | ~910 | 超大页面 |
| `src/pages/ApiPage.tsx` | ~820 | 超大页面 |
| `src/components/chat/QuickSettingsPanel.tsx` | ~860 | 超大组件 |


**轻语 vs SillyTavern 关键差距：**

| 维度 | 轻语 | SillyTavern |
| --- | --- | --- |
| AI 后端数 | 7（openai/claude/gemini/ollama/openrouter/vllm/lmstudio/tabby） | 40+（含 DeepSeek/Groq/Cohere/MistralAI/xAI 等） |
| 向量系统 | JSON 文件方案（vectorStore.ts 90行） | 9 个向量提供者 + vectra 库 + ONNX 本地模型 |
| 插件系统 | 无（仅 MCP） | 完整插件系统（动态加载 + git 自动更新） |
| i18n | 无（纯中文） | 17 种语言 |
| 多用户 | 无 | 完整多用户 + SSO |
| 安全 | API Key 加密 + 路径防护 | CSRF + CSP + rate limit + SSRF + host validation |
| 角色卡格式 | V1/V2/V3 PNG+JSON | V1/V2/V3 + 验证器 + BYAF + CharX |
| 图像后端 | SD WebUI + DALL-E | ComfyUI + SD WebUI + Horde + DALL-E + NovAI 等 |
| TTS 后端 | Windows 系统语音 | 多引擎 |
| 跨平台 | Windows only | Web 跨平台 |
| 测试文件 | 19 个（仅工具层） | 22 个（含 Playwright E2E） |
| CI/CD | 有（lint continue-on-error，152 个存量错误） | 有 |


### 执行注意事项

- 所有文件路径引用使用项目根相对路径（如 `src/store/useChatStore.ts:24`）
- 引用行号基于当前工作区状态，标注"约"字表示估算值
- 对比结论保持客观：轻语是桌面客户端定位，部分 ST 的 Web 安全机制（CSRF/CSP）对桌面端不直接适用，报告中需区分"桌面端无关"与"真实缺失"