# ComfyUI 生图配置优化实施计划

> 上游方案：[ComfyUI 生图配置优化方案](./ComfyUI生图配置优化方案.md)
> 状态：待实施
> 基线：PC 端 `electron/services/imageGen.ts`、`electron/services/comfyWorkflow.ts` 现状

## 1. 计划范围

本计划把上游方案拆成可逐项交付、可独立验证的改造步骤，覆盖工作流分析、配置数据结构、运行时覆盖、配置界面、旧数据迁移与跨端契约同步六个部分。

不包含的内容：

- OpenAI 生图与 SD WebUI 生图的参数模型调整，二者保持现状。
- 「自动生图」触发逻辑，本计划只改其调用的参数传递链，不改触发条件。
- ComfyUI 服务端的部署、插件安装与模型下载。

上游方案已确认的问题在代码中逐条核实过，不是理论推演：

| 方案条目 | 代码位置 | 现状 |
| --- | --- | --- |
| 通用默认值覆盖全部 KSampler | `imageGen.ts` 的 `customComfyWorkflow` 第 220—231 行 | `steps/cfg/sampler_name/scheduler/seed` 被统一改写为 `config` 值 |
| 覆盖全部 Latent 尺寸节点 | 同上第 216—219 行 | `width/height` 无条件写入 |
| 空 model 覆盖 Loader | 同上第 213—215 行 | 有 `CheckpointLoaderSimple` 时用 `config.model` 覆盖 |
| `imageGenSize` 越级覆盖 | `ipc/imageGen.ts` 第 93 行 | 优先级为 `options.size > settings.imageGenSize > config.size` |
| 参数排在表单前面 | `ImageGenModelsSection.tsx` 第 342—462 行 | 工作流卡片位于参数区之后 |
| 已有分析能力被浪费 | `comfyWorkflow.ts` 的 `inferSettings` 第 254—284 行 | 仅用于导入预览，运行时不再使用 |

## 2. 目标结构

改造后的参数流向，与现状的关键差别在于「工作流快照」与「用户覆盖」分离，运行时只把覆盖项写入指定节点：

```text
选择工作流 ──► 分析器 ──► 参数组 / 绑定 / 依赖
                 │
                 ├──► 工作流快照 (workflow)      可提交的完整 JSON
                 ├──► 参数组 (parameterGroups)  节点 ID + 输入名 + 原值 + 控件元信息
                 └──► 绑定 (bindings)           仅歧义时保存用户选择
                                                    │
用户修改参数 ──► 覆盖表 (overrides)  key = "57:3.steps"
                                                    │
运行时 ──► 深拷贝快照 ──► 写入提示词 ──► 应用覆盖 ──► 提交 /prompt
```

数据不重复存储：能从快照推导的一律不落盘，`overrides` 只记录用户改过的项，`bindings` 只记录自动识别无法唯一确定的项。

## 3. 模块设计

### 3.1 工作流分析器

改造 `electron/services/comfyWorkflow.ts`，把现有的画布转换与参数推断扩展为完整的分析器。

已有可复用的部分：`convertComfyCanvasWorkflow`（第 133—236 行）已能处理画布格式、Desktop 子图展开与旧版 seed 控件，这部分保留不动，只在其后接入分析。

需要新增或改造的部分：

- 输出可达性分析。现有 `hasImageOutput`（第 286 行）只判断「是否存在输出节点」，不判断节点是否连到输出。新增从 `SaveImage` / `PreviewImage` 反向遍历引用的可达集，未连到输出的实验节点不进入分析结果。反向遍历依赖 `inputs` 里的 `["节点ID", 槽位]` 引用形式，与 `imageGen.ts` 第 223—224 行现有的读取方式一致。
- 参数分组。现有 `inferSettings` 取第一个 KSampler 的值填充扁平字段，无法表达多阶段。改为遍历可达集，按 `节点 ID + 输入名` 生成参数项，再按采样阶段分组。
- 依赖识别。按 `节点 ID + 模型名输入` 提取，具体字段见上游方案 3.5 的节点对照表。需要排除 `weight_dtype`、`type`、`device`、`strength_*` 这类同节点的非模型输入。
- 提示词与输出绑定。沿用现有 `inferSettings` 第 256—261 行的负面节点识别思路，扩展到正面节点与输出节点，并区分「唯一确定」与「存在歧义」。
- `/object_info` 接入。取参数类型、范围与选项。服务不可达时按上游方案第 6 节的降级表处理，按 JS 类型渲染控件，不阻塞编辑。

分析器保持纯函数形态，输入为已规范化的 API 工作流与可选 `objectInfo`，输出 `ComfyWorkflowAnalysis`，不读写文件、不发请求。网络与文件读取留在调用侧，便于单元测试。

### 3.2 配置数据结构

新增 ComfyUI 专属结构，与现有 `ImageGenModelConfig`（`shared/types.ts` 第 766—788 行）并存。落盘方式有两种选择：

方案 A，联合类型：`Settings.imageGenModels` 改为 `(OpenAiImageGenConfig | SdWebUiImageGenConfig | ComfyImageGenConfig)[]`，按 `provider` 判别。

方案 B，单一结构加可选字段：保留 `ImageGenModelConfig`，新增字段全部可选。

推荐方案 A。理由：方案 B 无法阻止 ComfyUI 配置继续携带 `quality`、`size` 这类对 ComfyUI 无意义的字段，也无法在类型层面阻止 OpenAI 配置带上 `overrides`。方案 A 会让现有读写这些字段的位置出现类型错误，正好把需要同步修改的地方全部暴露出来，避免遗漏。代价是改动面更大，涉及 `useSettingsStore.ts`、`backup.ts`、`settings.ts` 的字段声明。

`provider` 字段同步收紧为字面量联合类型，当前它是 `string`，判别联合需要它可收窄。

`overrides` 的键使用 `节点 ID + 输入名`，例如 `57:3.steps`。子图内的节点 ID 已经带上 `57:3:` 前缀，与 `convertComfyCanvasWorkflow` 第 217 行生成节点键的规则一致，因此同一套键在两个阶段通用。

### 3.3 运行时覆盖

改造 `imageGen.ts` 的 `customComfyWorkflow`（第 170—258 行），删除第 213—233 行的整段自动覆盖逻辑，替换为：

1. 深拷贝已保存的工作流快照。
2. 按 `bindings` 写入提示词。
3. 随机化可达输出的第一个采样阶段的种子，后续阶段保持其原种子或引用，不独立随机化。
4. 逐项应用 `overrides`，只写目标节点的目标输入。
5. 提交。

同时删除 `buildComfyWorkflow`（第 260—269 行）中 `options?.size || config.size` 的取值链，以及 `ipc/imageGen.ts` 第 93 行对 `settings.imageGenSize` 的读取。尺寸只在 `overrides` 中出现时才写入。

现有占位符机制（`replaceWorkflowPlaceholders`，第 154—168 行）与 `{{prompt}}` 等替换保留，用于兼容用户在自定义节点里手写的占位符，但它不再是主要通道。占位符替换发生在覆盖之前，两者不冲突。

`defaultComfyWorkflow`（第 98—152 行）继续用于没有自定义工作流的内置工作流，它的 `config.steps ?? 20` 等默认值属于合法默认值，不在删除范围内。

### 3.4 配置界面

改造 `src/components/api/ImageGenModelsSection.tsx`：

- 调整区块顺序，工作流选择器移到表单首位。当前它位于第 465 行之后，需前移到第 342 行之前。
- 切换下拉后立即读取，去掉额外的读取按钮。现有 `loadLocalWorkflows`（第 123—136 行）已实现扫描，只需在 `onChange` 中触发导入。
- 参数区改为按分析结果动态渲染。`form.steps`、`form.cfgScale`、`form.sampler`、`form.scheduler`（第 409—463 行）这几段固定控件由动态控件替代。
- 未选择有效工作流时不渲染参数区，保存按钮禁用。
- 新增依赖状态卡与工作流检查卡。
- 原始 JSON 移入默认折叠的高级区。当前它应是表单中的文本域，需要确认位置后迁移。
- `emptyForm`（第 55—89 行）中 ComfyUI 分支的 `size/steps/cfgScale/sampler/scheduler/quality/model` 默认字段相应移除。

### 3.5 旧数据迁移

在 `electron/services/migration.ts` 注册 settings 域的新版本迁移。当前 `LATEST_VERSION.settings` 为 `1`（第 21 行），迁移表只有 `migrateSettingsV0ToV1`（第 34—41 行）。新增 `v1 → v2`：

1. 遍历 `settings.imageGenModels`，筛出 `provider === 'comfyui'` 的项。
2. 对有自定义工作流的项，解析并分析。
3. 比较旧 `size/steps/cfgScale/sampler/scheduler` 与工作流值。
4. 相同则丢弃，不同且目标节点唯一则写入 `overrides`。
5. 目标节点不唯一时不自动应用，标记待用户确认。
6. 旧 `model` 映射到唯一 Loader 节点，无法映射时保留警告字段。
7. 无自定义工作流的项，把内置工作流显式保存到 `workflow`，并保留原有参数。

迁移函数必须幂等，与 `migrateData`（第 105—134 行）的约定一致。迁移过程中不发起网络请求，`/object_info` 相关判断留到用户打开配置页时进行。

### 3.6 跨端契约同步

`imageGenSize` 同时存在于 PC 与 Android 的设置快照契约中，删除它需要三端同步，具体位置见上游方案第 10 节。执行顺序：

1. 先改 `settingsSync.ts`、`routes.ts` 的快照构造与字段校验。
2. 同步 `shared/fixtures/settings_snapshot.json` 与 Android 的 `settings_snapshot.json` fixture。
3. 同步 `contractFixtures.test.ts` 的 `EXPECTED_WHITELIST`（第 42—47 行）与 `ProtocolContractTest.kt` 的字段清单。
4. 再改运行时，删除 `ipc/imageGen.ts` 第 93 行的读取。

第 3 步不能省。`contractFixtures.test.ts` 第 70—74 行会断言快照键集与白名单完全相等，只改实现不改断言必然失败。

## 4. 接口设计

分析器对外暴露两个函数，均放在 `comfyWorkflow.ts` 并从 `ipc/imageGen.ts` 经 IPC 暴露。

`analyzeComfyWorkflow`

| 项 | 内容 |
| --- | --- |
| 输入 | `workflow: ApiWorkflow`，`objectInfo?: Record<string, unknown>` |
| 输出 | `ComfyWorkflowAnalysis` |
| 失败 | 抛出 `Error`，消息区分「无输出节点」「提示词入口缺失」「节点类型缺失」 |
| 网络 | 不发请求 |

`analyzeComfyWorkflowFile`

| 项 | 内容 |
| --- | --- |
| 输入 | `path: string`，`objectInfo?` |
| 输出 | 同 `analyzeComfyWorkflow`，附带 `workflow` 快照与 `workflowMeta` |
| 失败 | 返回 `{ success: false, error }`，沿用现有 `ImportedComfyWorkflow` 的结果形态 |
| 约束 | 仅允许已扫描到的 Desktop 路径，沿用 `isKnownWorkflowPath`（第 358—363 行）的校验 |

新增 IPC 通道，命名沿用现有前缀：

```text
imageGen:analyzeComfyWorkflow    (workflow, objectInfo)  -> ComfyWorkflowAnalysis
imageGen:fetchObjectInfo         (baseUrl, apiKey)        -> Record<string, unknown>
```

`imageGen:fetchObjectInfo` 便于在连接检测成功后缓存节点定义，避免分析时重复请求。`preload.ts` 第 264—265 行已有同类通道注册，新增两项按其写法追加。

`ComfyWorkflowAnalysis`、`WorkflowParameter` 等类型的定义见上游方案第 6 节，实现时直接采用。

## 5. 交付阶段

### 阶段一 工作流分析器

改动 `comfyWorkflow.ts`，新增 `analyzeComfyWorkflow` 与可达性分析，接入 `object_info` 降级逻辑，输出 `ComfyWorkflowAnalysis`。

验证：扩展 `electron/services/__tests__/comfyWorkflow.test.ts`，覆盖上游方案第 12 节「工作流分析」全部条目。该文件已有画布转换用例，新增用例沿用其 `convertComfyCanvasWorkflow` 的构造方式。

阶段一可独立合入，不影响运行时。

### 阶段二 数据结构与运行时

按方案 A 收紧 `ImageGenModelConfig`，补齐类型错误牵出的调用点，改造 `customComfyWorkflow` 与 `buildComfyWorkflow`，删除 `imageGenSize` 的运行时优先级。

验证：扩展 `electron/services/__tests__/imageGen.comfyui.test.ts`，该文件已断言提交体（第 45—48 行），改为断言「无覆盖时提交体与快照一致」「单参数覆盖时只有目标节点变化」。

阶段二与阶段三之间需要一次数据兼容处理：新结构写入后，旧版本配置在读取时由迁移补齐。

### 阶段三 配置界面

重排 `ImageGenModelsSection.tsx`，接入动态参数控件、依赖卡与检查卡，把原始 JSON 移入高级区。

验证：新增组件测试，放在 `src/components/api/__tests__/`，沿用 `CoverStep.test.tsx` 的 store mock 方式。

### 阶段四 迁移与契约

注册 settings `v1 → v2` 迁移，同步三端契约与 fixture，补迁移测试。

验证：扩展 `electron/services/__tests__/migration.test.ts`，并在 `contractFixtures.test.ts`、`ProtocolContractTest.kt` 中确认契约一致。

### 阶段五 实机验收

用本地 `image_z_image_turbo` 工作流生成，确认参数为 1080×1920、8 Steps、CFG 1、res_multistep、simple；改单项后确认只有目标节点变化；恢复默认后确认回到原值。

## 6. 验证方式

统一命令，与 `package.json` 第 9 行起的脚本一致：

```bash
npm run check    # tsc -b --noEmit 与 electron 配置的类型检查
npm run lint     # eslint .
npm run test     # vitest run
```

运行时行为不靠出图效果判断。对同一工作流分别在「无覆盖」与「单参数覆盖」两种状态下抓取提交给 `/prompt` 的请求体，断言除目标字段外其余节点与快照逐字节一致。这样断言可自动化，也不受采样随机性影响。

## 7. 风险与处理

多阶段工作流的种子处理是上游方案里最含糊的一处。方案原文说「随机化目标采样阶段」，但多阶段工作流通常只有第一阶段接受随机种子，精修与放大阶段继承前一阶段结果。实现时把规则明确为「可达输出的第一个采样阶段」，其余阶段保持原值。若某工作流的所有阶段都显式接受种子，则只随机化第一阶段，避免阶段间不一致。

方案 A 带来的改动面是本计划最大的不确定性。`provider` 从 `string` 收紧为联合类型后，所有按字符串比较 `provider` 的位置都会暴露。执行阶段二前先跑一次 `npm run check`，把报错位置全部列出再动手，避免边改边发现。

`/object_info` 的缓存需要跟随连接地址变化失效，否则切换 Base URL 后会用到上一个服务的节点定义，导致控件选项错误。

迁移中「目标节点不唯一」的判定依赖分析器的可达性结果。若分析器尚未合入就执行迁移，会出现误判。阶段四必须排在阶段一之后。
