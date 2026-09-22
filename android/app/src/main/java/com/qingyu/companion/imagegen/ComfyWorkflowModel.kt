package com.qingyu.companion.imagegen

/**
 * ComfyUI 工作流域模型（对齐 `shared/types.ts` / `shared/ipc-api.ts` 的 Comfy* 类型）。
 *
 * 只承载**纯分析逻辑**所需的数据形状：
 * Android 不扫描 PC 本地工作流目录（`listLocalComfyWorkflows` / Desktop installations 均为 PC 专有）。
 */

/** 分析器行为版本（PC `COMFY_ANALYZER_VERSION`）。 */
const val COMFY_ANALYZER_VERSION: Int = 2

/** API 格式工作流的一个节点（PC `ApiNode`）。 */
class ComfyNode(
    val classType: String,
    /** 输入表：值为 String/Boolean/[RawNumber]/[Map]/`List<Any?>`（`[节点ID, 槽位]` 引用）。 */
    val inputs: MutableMap<String, Any?>,
    val title: String? = null,
)

/** API 格式工作流：节点 ID → 节点（保序）。 */
typealias ComfyWorkflow = LinkedHashMap<String, ComfyNode>

/** 负面提示词的写入策略：保留工作流、使用预设或显式清空。 */
enum class ComfyNegativePromptMode(val wire: String) {
    Workflow("workflow"),
    Preset("preset"),
    Empty("empty"),
    ;

    companion object {
        fun fromWire(value: String): ComfyNegativePromptMode? =
            entries.firstOrNull { it.wire == value.lowercase() }
    }
}

/** 提示词精确写入目标；同一节点可同时暴露 text_g / text_l 等多个输入。 */
data class ComfyPromptTarget(
    val nodeId: String,
    val inputName: String,
)

/** 提示词与输出节点的角色绑定；用户确认后始终保存，运行时不再重新猜测。 */
data class ComfyWorkflowBindings(
    val positivePromptTargets: List<ComfyPromptTarget>? = null,
    val negativePromptTargets: List<ComfyPromptTarget>? = null,
    /** 旧配置兼容：读取时映射为 nodeId + `text`。 */
    val positivePromptNodeIds: List<String>? = null,
    val negativePromptNodeIds: List<String>? = null,
    val outputNodeIds: List<String>,
)

/** 工作流来源元信息（平台本地变更检测用；sourcePath 为来源展示字段）。 */
data class ComfyWorkflowMeta(
    val sourceName: String? = null,
    val sourcePath: String? = null,
    val nodeCount: Int,
    val converted: Boolean,
    val hash: String,
    val analyzerVersion: Int = COMFY_ANALYZER_VERSION,
)

/** 工作流用途判定，用于决定能否作为普通文生图配置保存。 */
enum class ComfyWorkflowKind { TextToImage, ImageToImage, Video, Unknown }

/** 分析过程中的可提示问题；不阻断分析，但会影响 compatible。 */
enum class ComfyWorkflowWarningCode {
    NoOutput, NoPrompt, AmbiguousPrompt, AmbiguousOutput, UnknownNode, MissingModel,
    RequiresImageInput, VideoWorkflow, MultiStage, UnreachableNodes,
}

data class ComfyWorkflowWarning(
    val code: ComfyWorkflowWarningCode,
    val message: String,
    val nodeIds: List<String>? = null,
)

enum class ComfyBindingRole { Positive, Negative, Output }

/** 提示词与输出节点的角色绑定候选。 */
data class ComfyWorkflowBinding(
    val role: ComfyBindingRole,
    val nodeId: String,
    val inputName: String? = null,
    val title: String? = null,
    /** 工作流中的原始文本，仅用于入口确认和预设初始化。 */
    val workflowValue: String? = null,
)

enum class ComfyParameterType { Number, Select, Text, Boolean, Size }

enum class ComfyParameterStage { Output, Sampling, Model, Custom }

/** 单个可调参数；id 即运行时覆盖表的键（`节点ID.输入名`）。 */
data class ComfyWorkflowParameter(
    val id: String,
    val nodeId: String,
    val inputName: String,
    val label: String,
    val type: ComfyParameterType,
    val workflowValue: Any?,
    /** Size 类型的第二个输入名（height）；运行时覆盖需同时写入 width 与 height。 */
    val pairedInputName: String? = null,
    val pairedWorkflowValue: Any? = null,
    val options: List<Any?>? = null,
    val min: Double? = null,
    val max: Double? = null,
    val step: Double? = null,
    val required: Boolean = true,
    /** 归入高级设置折叠区，默认不展示（如随机种子）。 */
    val advanced: Boolean = false,
)

/** 参数分组：输出尺寸、各采样阶段、模型侧可调项。 */
data class ComfyWorkflowParameterGroup(
    val id: String,
    val nodeId: String,
    val classType: String,
    val title: String,
    val stage: ComfyParameterStage,
    val parameters: List<ComfyWorkflowParameter>,
)

data class ComfyUsage(val nodeId: String, val inputName: String)

/** 模型依赖条目（按 `节点ID + 模型名输入` 建立）。 */
data class ComfyWorkflowDependency(
    val nodeId: String,
    val inputName: String,
    val classType: String,
    val label: String,
    val value: String,
    val provides: List<String>,
    val usedBy: List<ComfyUsage>,
    /** 来自 /object_info 的可用文件列表；缺失表示无法校验。 */
    val options: List<String>? = null,
    /** 仅在能取得 options 时给出：当前 value 是否在可用列表中。 */
    val available: Boolean? = null,
)

data class ComfyWorkflowAnalysis(
    val kind: ComfyWorkflowKind,
    val nodeCount: Int,
    val compatible: Boolean,
    val promptBindings: List<ComfyWorkflowBinding>,
    val outputBindings: List<ComfyWorkflowBinding>,
    val parameterGroups: List<ComfyWorkflowParameterGroup>,
    val dependencies: List<ComfyWorkflowDependency>,
    val warnings: List<ComfyWorkflowWarning>,
)
