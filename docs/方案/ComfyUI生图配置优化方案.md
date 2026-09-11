# ComfyUI 生图配置优化方案

> 状态：已实施（2026-09-11），实施计划见[ComfyUI 生图配置优化实施计划](./ComfyUI生图配置优化实施计划.md)

## 1. 背景

当前 ComfyUI 生图配置先展示一组固定参数，工作流选择反而位于表单底部。工作流导入后，运行时还会使用通用默认值覆盖工作流中的原始参数：

- 图片尺寸：512×512
- 采样步数：20
- CFG：7
- 采样器：euler
- 调度器：normal

这会破坏 Z-Image、FLUX 以及多阶段工作流自带的参数。例如 `image_z_image_turbo` 的原始配置是 `1080×1920 / 8 Steps / CFG 1 / res_multistep / simple`，不应被通用默认值覆盖。

## 2. 优化目标

将 ComfyUI 配置改为“工作流是唯一事实来源”：

1. 用户先选择工作流。
2. 系统自动分析工作流。
3. 仅展示该工作流实际存在且允许调整的参数。
4. 工作流原值作为默认值。
5. 只有用户明确修改的参数才在运行时覆盖对应节点。
6. 删除与工作流重复或对 ComfyUI 无效的通用字段。

## 3. 推荐配置流程

### 3.1 选择工作流

ComfyUI 表单打开后，工作流选择器应成为第一个主要控件：

```text
选择工作流
[ image_z_image_turbo ▼ ] [重新扫描]
[选择其他 JSON]

✓ 文生图工作流
✓ 10 个有效节点
✓ 模型依赖完整
```

- 自动扫描 ComfyUI Desktop 的本地工作流。
- 切换下拉选项后立即读取，不再要求额外点击“读取”。
- 支持选择其他画布格式或 API 格式 JSON。
- 导入后显示工作流类型、节点数量、更新时间和兼容状态。
- 未选择有效工作流前，不显示采样参数，也不允许保存。

### 3.2 连接配置

工作流选定后显示连接区：

- Base URL，默认 `http://127.0.0.1:8188`。
- API Key，仅远程 ComfyUI 使用，默认折叠。
- 自动检测连接状态。
- 提供“重新检测”按钮。

本地工作流扫描不依赖 ComfyUI 服务，因此工作流仍应排在连接配置之前；连接成功后再从服务读取节点定义和模型列表。

### 3.3 工作流分析结果

系统自动识别：

- 正面提示词节点。
- 负面提示词节点。
- SaveImage、PreviewImage 等输出节点。
- 参与最终输出的 KSampler 和 KSamplerAdvanced。
- Latent 尺寸节点。
- Checkpoint、UNet、CLIP、VAE、LoRA 等模型依赖。
- 是否需要输入图片。
- 是否存在缺失节点、缺失模型或无法识别的自定义节点。
- 是否包含基础生成、精修、放大等多个阶段。

分析结果建议使用状态卡展示：

```text
工作流检查
● 文生图，可用于 /imagine
● 10 个执行节点
● 3 个模型依赖均可用
● 正面提示词入口已识别
```

存在缺失项时应显示具体节点或文件，并禁止保存。

### 3.4 动态参数配置

只显示工作流实际包含的参数：

```text
输出
尺寸          1080 × 1920

基础采样 · KSampler #57:3
Steps         8
CFG           1
Sampler       res_multistep
Scheduler     simple

[恢复工作流默认值]
```

规则：

- 单个 KSampler 直接显示为“采样设置”。
- 多个 KSampler 按节点标题、阶段和节点 ID 分组。
- 参数旁显示“工作流值”或“已覆盖”状态。
- 用户修改后只记录该节点的具体输入。
- 提供单项恢复和全部恢复。
- 工作流没有负面提示词入口时，不显示负面提示词。
- 工作流不允许修改尺寸时，不显示尺寸控件。

### 3.5 模型依赖

模型文件不再使用单个“Checkpoint 文件名”文本框，而是从工作流节点提取：

```text
模型依赖
UNet    z_image_turbo_bf16.safetensors  ✓
CLIP    qwen_3_4b.safetensors           ✓
VAE     ae.safetensors                  ✓
```

- 已找到的模型只读展示。
- 缺失模型显示警告和可选文件列表。
- 用户替换模型时，仅覆盖对应 Loader 节点。
- 支持 CheckpointLoaderSimple、UNETLoader、CLIPLoader、VAELoader 和常见 LoRA Loader。

各 Loader 的绑定字段与其模型名输入：

| 节点 | 模型名输入 | 说明 |
| --- | --- | --- |
| CheckpointLoaderSimple | `ckpt_name` | 同时提供 MODEL / CLIP / VAE 三个输出 |
| UNETLoader | `unet_name` | 另有 `weight_dtype`，属于精度选项而非模型名 |
| CLIPLoader | `clip_name` | 另有 `type` 与 `device`，不是模型名 |
| VAELoader | `vae_name` | 单输出 |
| LoraLoader | `lora_name` | 另有 `strength_model`、`strength_clip`，与模型名同属可调项 |
| LoraLoaderModelOnly | `lora_name` | 另有 `strength_model` |

依赖列表按 `节点 ID + 模型名输入` 建立，避免把 `weight_dtype`、`type`、`device`、`strength_*` 这类同节点的非模型输入误判为模型名。Z-Image 这类用 UNETLoader + CLIPLoader + VAELoader 组合的工作流不会出现 `CheckpointLoaderSimple`，依赖区应展示三个独立条目而非单一的 Checkpoint 行。

引用方可通过 `["节点ID", 输出槽位]` 反查依赖被谁使用：例如 CLIPLoader 的 0 号输出被两个 CLIPTextEncode 引用时，两个提示词节点应共享同一个依赖条目。

### 3.6 高级设置

以下内容默认折叠：

- 固定或随机种子。
- 提示词节点绑定。
- 输出节点选择。
- 未识别的自定义节点参数。
- 原始 API 工作流 JSON。
- 工作流来源路径、哈希和分析器版本。

## 4. 冗余参数处理

| 当前参数 | 调整方案 |
| --- | --- |
| Checkpoint 文件名 | 删除固定输入，从具体 Loader 节点读取 |
| UNet / CLIP / VAE 模型名 | 分别绑定 UNETLoader、CLIPLoader、VAELoader，不使用统一文本框 |
| LoRA 模型名与权重 | 绑定 LoraLoader / LoraLoaderModelOnly，权重与模型名同属可调项 |
| 图片尺寸 | 仅检测到可调 Latent 尺寸时显示 |
| 负面提示词 | 仅检测到负面条件节点时显示 |
| Steps | 仅检测到对应 KSampler 输入时显示 |
| CFG | 仅工作流包含该输入时显示 |
| Sampler | 从具体 KSampler 读取，不再使用通用默认值 |
| Scheduler | 从具体 KSampler 读取 |
| Quality | 从 ComfyUI 配置中删除，仅 OpenAI 使用 |
| Model | 从 ComfyUI 配置中删除，改为节点级模型依赖 |
| imageGenSize | 删除全局覆盖和同步字段 |
| 原始工作流 JSON | 保留，但移入高级设置 |
| Base URL | 保留 |
| API Key | 保留为远程服务的高级可选项 |
| 配置名称 | 保留，默认使用工作流名称 |

“自动生图”属于行为功能，不是工作流参数，本方案不删除其底层兼容逻辑。

## 5. 数据结构调整

建议将统一的生图配置拆分为提供商专属结构，ComfyUI 不再保存 SD WebUI 风格的通用字段。

```ts
interface ComfyImageGenConfig {
  id: string
  name: string
  provider: 'comfyui'
  baseUrl: string
  apiKey?: string
  enabled: boolean
  order: number

  workflow: string
  workflowMeta: {
    name: string
    sourcePath?: string
    hash: string
    analyzerVersion: number
  }

  bindings: {
    positivePromptNodeIds: string[]
    negativePromptNodeIds?: string[]
    outputNodeIds: string[]
  }

  overrides: Record<string, unknown>
}
```

设计原则：

- `workflow` 保存可执行快照，原文件被移动后仍可运行。
- `workflowMeta` 用于展示来源并检测文件更新。
- 可从工作流重新推导的数据不重复持久化。
- `bindings` 只保存自动识别无法唯一确定时的用户选择。
- `overrides` 只保存用户修改项，键使用“节点 ID + 输入名”，例如 `57:3.steps`。

## 6. 工作流分析接口

扩展工作流导入结果：

```ts
interface ComfyWorkflowAnalysis {
  kind: 'text-to-image' | 'image-to-image' | 'video' | 'unknown'
  nodeCount: number
  compatible: boolean
  promptBindings: WorkflowBinding[]
  outputBindings: WorkflowBinding[]
  parameterGroups: WorkflowParameterGroup[]
  dependencies: WorkflowDependency[]
  warnings: WorkflowWarning[]
}

interface WorkflowParameter {
  id: string
  nodeId: string
  inputName: string
  label: string
  type: 'number' | 'select' | 'text' | 'boolean' | 'size'
  workflowValue: unknown
  options?: unknown[]
  min?: number
  max?: number
  step?: number
  required: boolean
}
```

工作流本身只能提供当前值，参数类型、范围和可选项应通过 ComfyUI `/object_info` 获取，避免继续维护硬编码的采样器和调度器列表。

分析时只处理能够连接到最终图片输出的节点，忽略断开的实验节点。

`/object_info` 不可用时的降级（本地离线配置是正常场景，不能因此禁止编辑）：

| 场景 | 行为 |
| --- | --- |
| 服务可连，节点类型存在 | 使用 `/object_info` 的类型、范围和选项渲染控件 |
| 服务不可连 | 依据工作流当前值的 JS 类型渲染控件，`select` 退化为可输入下拉，仅允许修改为字符串 |
| 节点类型缺失 | 标记为未知节点，参数只读展示，禁止保存 |

降级只影响控件形态，不改变“原值即默认值、只提交用户改动”的核心规则。`objectInfo` 的获取结果应按服务地址缓存并在重新检测时失效，避免每次切换参数都请求一次。

## 7. 运行时改造

生成图片时：

1. 深拷贝已保存的工作流快照。
2. 根据绑定将提示词写入指定节点。
3. 默认只随机化目标采样阶段的种子。
4. 逐项应用用户保存的节点级覆盖。
5. 提交处理后的工作流。

必须删除以下行为：

- 不再遍历并覆盖所有 KSampler。
- 不再覆盖所有 EmptyLatentImage 或 EmptySD3LatentImage。
- 不再使用空的通用 `model` 字段覆盖 Loader。
- 不再使用 `512x512 / 20 / 7 / euler / normal` 作为自定义工作流默认值。
- 不再让全局 `settings.imageGenSize` 覆盖工作流。

多采样阶段工作流必须按节点精确覆盖，避免将基础生成参数误写到精修或放大阶段。

## 8. 工作流兼容检查

保存前应完成静态检查：

- 工作流格式有效。
- 至少包含一个图片输出节点。
- 能找到正面提示词入口。
- 所有节点类型均存在于当前 ComfyUI 的 `/object_info`。
- 模型文件能够在对应 Loader 的选项中找到。
- 不存在尚未配置的必要图片或视频输入。

工作流类型处理：

| 类型 | 行为 |
| --- | --- |
| 文生图 | 允许保存并用于 `/imagine` |
| 图生图 | 标记需要输入图片，不作为普通文生图配置 |
| 视频工作流 | 拒绝作为图片模型保存 |
| 未知工作流 | 允许进入高级绑定，但必须完成必要节点选择 |

“测试连接”与“测试生成”应分离。前者只检查服务和节点兼容性，不应自动触发耗时生图；后者由用户明确点击。

## 9. 旧配置迁移

升级配置版本后，对旧 ComfyUI 配置执行一次迁移：

1. 解析已有工作流。
2. 重新识别提示词、输出和可调参数。
3. 将旧的 `size`、`steps`、`cfgScale`、`sampler`、`scheduler` 与工作流值比较。
4. 与工作流相同的字段直接删除。
5. 与工作流不同且目标节点唯一的字段转为节点级覆盖。
6. 多节点情况下不静默应用旧值，显示一次迁移确认。
7. 将旧 `model` 映射到明确的 Loader 节点；无法映射时保留警告。
8. 删除全局 `imageGenSize`；若能唯一定位尺寸节点，可一次性转换为该节点的覆盖。

对于没有自定义工作流的旧 ComfyUI 配置，将当前内置基础工作流显式保存为“基础文生图工作流”，不再隐式回退。

## 10. 跨端设置契约影响

`imageGenSize` 不是 PC 端独有字段，它同时存在于移动端设置快照契约中。直接删除会破坏 PC 与 Android 之间的快照校验，必须与迁移同步处理。

当前涉及位置：

| 位置 | 用途 |
| --- | --- |
| `shared/types.ts` | `Settings.imageGenSize` 字段定义 |
| `shared/defaults.ts` | 默认设置中未显式声明该字段，读取时由各处兜底 |
| `electron/bridge/settingsSync.ts` | 快照白名单、字段类型校验器 |
| `electron/bridge/routes.ts` | 对外快照字段映射 |
| `shared/fixtures/settings_snapshot.json` | 契约 fixture |
| `android/.../ApiDtos.kt` | 移动端快照 DTO 字段 |
| `android/.../SettingsOwnership.kt` | 字段归属清单与读写分支 |
| `electron/bridge/__tests__/contractFixtures.test.ts` | 白名单钉死断言，新增或删除字段必须显式评审 |
| `android/.../ProtocolContractTest.kt` | 移动端契约断言 |

处理原则：

1. 快照 `schemaVersion` 从当前值递增，`SETTINGS_SNAPSHOT_CAPABILITIES` 同步更新。
2. PC 端停止写入 `imageGenSize`，但快照构造器仍保留读取兼容，避免旧版移动端收到缺失字段时报错。
3. 移动端 DTO 保留字段并标注废弃，默认值不变；待移动端发版后再统一移除。
4. 三方契约测试的白名单断言必须与本次变更同步修改，不能只改 PC 端实现。
5. `imageGenAutoEnabled` 属于行为开关，继续保留在契约中。

若本次只删 PC 端而不同步契约测试，`contractFixtures.test.ts` 与 `ProtocolContractTest.kt` 会直接失败。实施顺序应为：先更新契约与测试，再删除运行时优先级。

## 11. 实施阶段

### 阶段一：工作流分析器

- 增加节点分类、依赖识别和输出可达性分析。
- 接入 `/object_info`。
- 输出统一的 `ComfyWorkflowAnalysis`。
- 覆盖经典工作流、Desktop 子图和 API 工作流。

### 阶段二：数据与运行时

- 引入 ComfyUI 专属配置结构。
- 实现节点级绑定和覆盖。
- 删除通用默认值对工作流的覆盖。
- 删除 `imageGenSize` 运行时优先级。

### 阶段三：工作流优先界面

- 重排配置表单。
- 自动读取工作流。
- 动态生成参数控件。
- 增加依赖和兼容状态卡。
- 将原始 JSON 移入高级区域。

### 阶段四：迁移与验收

- 迁移已有配置。
- 同步快照契约、fixture 与三端契约测试。
- 增加异常工作流提示。
- 完成单元测试、组件测试和本机 ComfyUI 实测。

## 12. 测试计划

### 工作流分析

- 经典画布工作流可以转换。
- Desktop 子图可以展开并保持连接。
- API 格式工作流可以直接导入。
- 正确识别 Z-Image 的 UNet、CLIP、VAE 和 KSampler。
- 正确识别 CheckpointLoaderSimple。
- 正确识别 UNETLoader / CLIPLoader / VAELoader 组合，且不把 `weight_dtype` 等非模型输入误判为模型名。
- 正确识别 LoraLoader 的模型名与强度。
- 正确识别多个 KSampler 阶段。
- 仅分析能够连接到输出的节点。
- 图生图和视频工作流不会误判为文生图。
- `/object_info` 不可用时按 JS 类型降级渲染，不阻塞编辑。

### 参数配置

- 未选择工作流时不显示参数区域。
- Z-Image 不显示固定 Checkpoint 输入。
- 工作流没有负面条件节点时不显示负面提示词。
- 多阶段工作流按节点分组。
- 自定义节点参数使用 `/object_info` 的类型和范围。
- 恢复默认值后删除对应覆盖项。

### 运行时

- 没有覆盖项时，提交内容与工作流原值一致。
- 修改 Steps 只影响目标 KSampler。
- 修改尺寸只影响目标 Latent 节点。
- 不会修改精修或放大阶段的同名参数。
- 提示词只写入选定的正面节点。
- 缺失模型或节点时不会提交到 ComfyUI。

运行时测试不依赖出图效果判断，直接比对提交给 `/prompt` 的 JSON：同一工作流分别在“无覆盖”和“单参数覆盖”两种状态下提交，断言除目标字段外其余节点与工作流快照逐字节一致。种子随机化范围限定为可达最终输出的第一个采样阶段，后续阶段继承其种子，不被独立随机化。

### 配置迁移

- 与工作流相同的旧字段被删除。
- 唯一目标的差异值可以转换为节点覆盖。
- 多节点歧义不会被静默迁移。
- 旧配置迁移后仍可生图。
- 删除 `imageGenSize` 后快照契约、fixture 与三端契约测试同步通过。

### 实机验收

- 使用本地 `image_z_image_turbo` 工作流生成图片。
- 确认使用工作流原生的 1080×1920、8 Steps、CFG 1、res_multistep 和 simple。
- 修改单个参数后重新生成，确认只影响对应节点。
- 恢复默认值后确认工作流恢复原始参数。
- 对比无覆盖与有覆盖两次提交的 JSON，确认非目标节点未被改动。

## 13. 验收标准

- 用户必须先选择工作流，之后才出现配置参数。
- 界面不再展示与当前工作流无关的字段。
- 工作流参数不会被通用默认值静默覆盖。
- Z-Image、FLUX、SDXL 和多阶段工作流可以保留各自原始配置。
- UNETLoader / CLIPLoader / VAELoader 组合与 LoRA 依赖能够被正确识别和替换。
- 缺失节点、模型和输入时能够给出明确错误。
- `/object_info` 不可用时仍可查看并手动覆盖工作流参数。
- 旧配置能够安全迁移，不丢失原有生图能力。
- 删除 `imageGenSize` 后 PC 与移动端快照契约保持一致。
- 快捷设置中已移除的图片尺寸不再从后台覆盖工作流。
