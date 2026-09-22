package com.qingyu.companion.embedding

/**
 * 阶段 6 S6-05 第 2 档的**运行时抽象**：设备端移动端嵌入模型
 * （PC 侧是本地 ONNX worker，见总方案 §3.2「PC 本地 ONNX embedding」一行：
 * Android 在可用设备上用移动端运行时，不支持设备明确降级、不阻断关键词世界书）。
 *
 * 分两层：
 * - [LocalRuntimeSupportPolicy]：**纯判定**——这台设备能不能跑本地向量模型、
 *   不能跑是为什么（界面要把「为什么」显示出来）；
 * - [MobileEmbeddingRuntime]：**运行时接缝**——加载模型包、批量向量化、卸载。
 *   具体推理后端（ONNX Runtime Mobile / NNAPI / GPU delegate）需要 native 依赖，
 *   属于依赖决策（`build.gradle.kts` 不在本任务所有权内），接线与真机验证见交付报告。
 *
 * 判定层不猜产品口径：ABI / 最低内存这类门槛是**阶段 6 待决策项**
 * （总方案 §8「阶段 6：Android 本地 embedding 支持的 ABI、模型和最低内存」），
 * 因此做成 [SupportPolicy] 可注入参数 + 显式默认值，等决策签字后只改默认值。
 */

/** 设备能力读数（真机由 `Build` / `ActivityManager` 提供；测试直接注入）。 */
data class DeviceCapability(
    /** `Build.SUPPORTED_ABIS` 同序。 */
    val abis: List<String>,
    val apiLevel: Int,
    /** 设备总内存（MB，`ActivityManager.MemoryInfo.totalMem`）。 */
    val totalMemoryMb: Long,
    /** 用户是否允许使用设备端本地模型（设置里的显式开关）。 */
    val localModelAllowed: Boolean = true,
)

/** 支持门槛（可注入，等阶段 6 ABI/内存决策签字后只改默认值）。 */
data class SupportPolicy(
    val supportedAbis: Set<String> = DEFAULT_SUPPORTED_ABIS,
    val minApiLevel: Int = DEFAULT_MIN_API_LEVEL,
) {
    companion object {
        /** 默认支持全部 Android ABI（不因「移动端不方便」自行砍掉任何 ABI——阶段 6 决策前的口径）。 */
        val DEFAULT_SUPPORTED_ABIS: Set<String> = setOf("arm64-v8a", "armeabi-v7a", "x86_64", "x86")

        /** 应用 minSdk（运行时依赖的真实下限待接入 ONNX Runtime Mobile 后再收紧）。 */
        const val DEFAULT_MIN_API_LEVEL = 26
    }
}

sealed class LocalRuntimeSupport {
    data class Supported(val note: String) : LocalRuntimeSupport()

    data class Unsupported(val reason: Reason, val explanation: String) : LocalRuntimeSupport() {
        enum class Reason {
            /** 用户显式关闭了本地模型。 */
            USER_DISABLED,

            /** 设备 ABI 不在支持列表。 */
            ABI_UNSUPPORTED,

            /** 系统版本低于运行时下限。 */
            API_TOO_LOW,

            /** 设备内存低于所选模型的 `recommendedMemoryMb`。 */
            MEMORY_BELOW_RECOMMENDED,
        }
    }
}

object LocalRuntimeSupportPolicy {

    /**
     * 设备是否支持本地向量模型。[manifest] 为空时只判设备自身门槛
     * （还没选模型时不该拿某个模型的内存建议把设备判死）。
     */
    fun evaluate(
        device: DeviceCapability,
        manifest: EmbeddingModelManifest? = null,
        policy: SupportPolicy = SupportPolicy(),
    ): LocalRuntimeSupport {
        if (!device.localModelAllowed) {
            return LocalRuntimeSupport.Unsupported(
                LocalRuntimeSupport.Unsupported.Reason.USER_DISABLED,
                "已在设置中关闭设备端本地向量模型",
            )
        }
        if (device.apiLevel < policy.minApiLevel) {
            return LocalRuntimeSupport.Unsupported(
                LocalRuntimeSupport.Unsupported.Reason.API_TOO_LOW,
                "系统版本过低（Android ${device.apiLevel}），本地向量模型需要 Android ${policy.minApiLevel} 及以上",
            )
        }
        if (device.abis.none { it in policy.supportedAbis }) {
            return LocalRuntimeSupport.Unsupported(
                LocalRuntimeSupport.Unsupported.Reason.ABI_UNSUPPORTED,
                "设备 CPU 架构（${device.abis.joinToString("、")}）不在本地向量模型支持列表" +
                    "（${policy.supportedAbis.sorted().joinToString("、")}）",
            )
        }
        if (manifest != null && device.totalMemoryMb < manifest.recommendedMemoryMb) {
            return LocalRuntimeSupport.Unsupported(
                LocalRuntimeSupport.Unsupported.Reason.MEMORY_BELOW_RECOMMENDED,
                "设备内存 ${device.totalMemoryMb} MB 低于模型「${manifest.displayName}」建议的 " +
                    "${manifest.recommendedMemoryMb} MB，强行加载会拖垮前台生成",
            )
        }
        val modelNote = if (manifest == null) "" else "（模型「${manifest.displayName}」建议内存 ${manifest.recommendedMemoryMb} MB）"
        return LocalRuntimeSupport.Supported("设备支持本地向量模型$modelNote")
    }
}

/** 运行时加载结果。 */
sealed class LocalRuntimeLoad {
    data class Loaded(val dimensions: Int, val maxTokens: Int) : LocalRuntimeLoad()
    data class Failed(val reason: String) : LocalRuntimeLoad()
}

/**
 * 设备端移动端嵌入运行时接缝。
 *
 * 实现方（接线层选择具体后端）负责 tokenizer / 推理 / delegate 选择；
 * 这里只固定**上层依赖的合同**：批量输入输出同序同维、可卸载、失败可解释。
 */
interface MobileEmbeddingRuntime {
    /** 载入已通过 [ModelPackageInstaller] 校验的模型文件。 */
    fun load(modelFiles: Map<String, ByteArray>, manifest: EmbeddingModelManifest): LocalRuntimeLoad

    /** 批量向量化（顺序一一对应；查询/文档的前后缀截断策略与远程同口径）。 */
    fun embed(texts: List<String>, inputKind: EmbeddingInputKind): List<List<Double>>

    /** 释放运行时资源（切换模型 / 卸载模型包前调用）。 */
    fun unload()
}

/**
 * 本地模型的 [TextEmbedder] 适配：套上与远程一致的截断策略，
 * 使上层索引/检索代码对两档提供方完全无感。
 */
class LocalModelEmbedder(
    private val runtime: MobileEmbeddingRuntime,
    private val manifest: EmbeddingModelManifest,
) : TextEmbedder {
    override fun embed(texts: List<String>, inputKind: EmbeddingInputKind): List<List<Double>> {
        if (texts.isEmpty()) return emptyList()
        val clean = texts.map {
            EmbeddingProtocols.truncateEmbeddingInput(it, inputKind, EmbeddingProtocols.MAX_INPUT_CHARS)
        }
        val vectors = runtime.embed(clean, inputKind)
        if (vectors.size != clean.size) {
            throw EmbeddingException(
                EmbeddingFailureKind.INVALID_RESPONSE,
                "本地向量模型返回数量不匹配（输入 ${clean.size}，返回 ${vectors.size}），已中止以免向量错位",
            )
        }
        return vectors
    }
}

/**
 * 本地模型的索引切片字符数（PC `resolveIndexChunkChars` 的 local 分支：
 * `max(256, manifest.maxTokens × 2)`——字符只是切片单位，tokenizer 的真实截断在运行时）。
 */
fun localIndexChunkChars(manifest: EmbeddingModelManifest): Int =
    maxOf(256, manifest.maxTokens * 2)
