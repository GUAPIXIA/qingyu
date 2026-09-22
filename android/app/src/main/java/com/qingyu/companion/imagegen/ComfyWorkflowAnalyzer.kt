package com.qingyu.companion.imagegen

/**
 * ComfyUI 工作流纯分析逻辑（PC `electron/services/comfyWorkflow.ts` 的
 * `analyzeComfyWorkflow` / `inferSettings` 等价实现）。
 *
 * 纯函数：不读写文件、不发起请求；`objectInfo` 由调用侧（[ComfyUiProtocol] 解析
 * `/object_info`）获取后传入。只处理能从输出节点反向到达的节点，断开的实验节点不进入结果。
 */
object ComfyWorkflowAnalyzer {

    private val VIDEO_OUTPUT_NODES: Set<String> = setOf(
        "SaveWEBM", "SaveVideo", "VHS_VideoCombine", "SaveAnimatedWEBP", "SaveAnimatedPNG",
    )
    private val IMAGE_INPUT_NODES: Set<String> = setOf("LoadImage", "LoadImageMask", "LoadImageOutput")
    private val LATENT_SIZE_NODES: Set<String> = setOf("EmptyLatentImage", "EmptySD3LatentImage", "EmptyLatentImagePresets")
    private val SAMPLER_NODES: Set<String> = setOf("KSampler", "KSamplerAdvanced", "SamplerCustom", "SamplerCustomAdvanced")
    private val TEXT_ENCODE_NODES: Set<String> = setOf("CLIPTextEncode", "CLIPTextEncodeSDXL", "BNK_CLIPTextEncodeAdvanced")
    private val PROMPT_INPUT_NAMES: Set<String> = setOf(
        "text", "text_g", "text_l", "prompt", "positive_prompt", "negative_prompt",
    )

    /**
     * 条件链上的“屏障”节点：其输出不再携带上游文本的语义，回溯到此终止。
     * ConditioningZeroOut 会把条件整体清零（Z-Image 等工作流用它充当空负面条件），
     * 若继续向上回溯，会把被复用的正面文本节点误判成负面入口。
     */
    private val CONDITIONING_BARRIER_NODES: Set<String> = setOf("ConditioningZeroOut")
    private val NEGATIVE_NODE_HINTS: List<String> = listOf("negative", "neg", "负面", "反向")

    /** 采样阶段的参数白名单：只暴露可安全覆盖的项，避免把 latent_image 等连接写坏。 */
    private val SAMPLER_PARAM_SPECS: List<Triple<String, String, ComfyParameterType>> = listOf(
        Triple("steps", "Steps", ComfyParameterType.Number),
        Triple("cfg", "CFG", ComfyParameterType.Number),
        Triple("sampler_name", "Sampler", ComfyParameterType.Select),
        Triple("scheduler", "Scheduler", ComfyParameterType.Select),
        Triple("denoise", "Denoise", ComfyParameterType.Number),
        Triple("seed", "种子", ComfyParameterType.Number),
        Triple("noise_seed", "种子", ComfyParameterType.Number),
    )
    private val ADVANCED_SAMPLER_PARAMS: Set<String> = setOf("denoise", "seed", "noise_seed")

    /** Loader 节点对照表；weight_dtype / type / device 等不属于模型名，故不在此表。 */
    data class LoaderTuning(val inputName: String, val label: String, val type: ComfyParameterType)

    data class LoaderSpec(
        val inputName: String,
        val label: String,
        val provides: List<String>,
        val tuning: List<LoaderTuning> = emptyList(),
    )

    val LOADER_SPECS: Map<String, LoaderSpec> = mapOf(
        "CheckpointLoaderSimple" to LoaderSpec("ckpt_name", "Checkpoint", listOf("MODEL", "CLIP", "VAE")),
        "UNETLoader" to LoaderSpec(
            "unet_name", "UNet", listOf("MODEL"),
            listOf(LoaderTuning("weight_dtype", "精度", ComfyParameterType.Select)),
        ),
        "CLIPLoader" to LoaderSpec(
            "clip_name", "CLIP", listOf("CLIP"),
            listOf(
                LoaderTuning("type", "CLIP 类型", ComfyParameterType.Select),
                LoaderTuning("device", "设备", ComfyParameterType.Select),
            ),
        ),
        "VAELoader" to LoaderSpec("vae_name", "VAE", listOf("VAE")),
        "LoraLoader" to LoaderSpec(
            "lora_name", "LoRA", listOf("MODEL", "CLIP"),
            listOf(
                LoaderTuning("strength_model", "LoRA 强度（模型）", ComfyParameterType.Number),
                LoaderTuning("strength_clip", "LoRA 强度（CLIP）", ComfyParameterType.Number),
            ),
        ),
        "LoraLoaderModelOnly" to LoaderSpec(
            "lora_name", "LoRA", listOf("MODEL"),
            listOf(LoaderTuning("strength_model", "LoRA 强度", ComfyParameterType.Number)),
        ),
    )

    private fun isReference(value: Any?): Boolean =
        value is List<*> && value.size >= 2 && value[0] is String

    private fun referenceNodeId(value: Any?): String? =
        if (isReference(value)) (value as List<*>)[0] as String else null

    private fun nodeLabel(nodeId: String, node: ComfyNode): String =
        node.title?.trim()?.takeIf { it.isNotEmpty() } ?: "${node.classType} #$nodeId"

    /** 从输出节点反向遍历输入引用，得到真正参与最终产出的节点集合。 */
    private fun collectReachable(workflow: ComfyWorkflow, outputIds: List<String>): Set<String> {
        val reachable = HashSet<String>()
        val stack = ArrayDeque(outputIds)
        while (stack.isNotEmpty()) {
            val nodeId = stack.removeLast()
            if (nodeId in reachable) continue
            val node = workflow[nodeId] ?: continue
            reachable.add(nodeId)
            for (value in node.inputs.values) {
                val referenced = referenceNodeId(value)
                if (referenced != null && referenced !in reachable) stack.addLast(referenced)
            }
        }
        return reachable
    }

    /** 节点标题是否明确标示负面提示词；仅在采样器没有 negative 输入时兜底。 */
    private fun hasNegativeTitleHint(node: ComfyNode): Boolean {
        val title = (node.title ?: "").lowercase()
        return NEGATIVE_NODE_HINTS.any { title.contains(it) }
    }

    /**
     * 列出节点中可由用户绑定的文本输入。
     * 已知编码器支持 text / text_g / text_l 等多字段；自定义节点则只接受
     * 名称明确表示提示词的字符串输入，避免把模型文件名等普通字符串暴露为提示词。
     */
    internal fun promptInputs(node: ComfyNode): List<Pair<String, String>> {
        val knownEncoder = node.classType in TEXT_ENCODE_NODES ||
            Regex("text.*encode|encode.*text", RegexOption.IGNORE_CASE).containsMatchIn(node.classType)
        val result = mutableListOf<Pair<String, String>>()
        for ((inputName, raw) in node.inputs) {
            if (raw !is String) continue
            val normalized = inputName.lowercase()
            val promptLike = normalized in PROMPT_INPUT_NAMES ||
                Regex("(^|_)(prompt|text)(_|$)").containsMatchIn(normalized)
            if (promptLike && (knownEncoder || normalized in PROMPT_INPUT_NAMES)) {
                result.add(inputName to raw)
            }
        }
        return result
    }

    /**
     * 沿 conditioning 引用链回溯，收集起点能到达的文本节点。
     * 遇到 CONDITIONING_BARRIER_NODES 时停止（其输出已不含上游文本语义）。
     */
    private fun collectPromptNodes(
        workflow: ComfyWorkflow,
        startIds: List<String>,
        textNodeSet: Set<String>,
    ): Set<String> {
        val found = HashSet<String>()
        val visited = HashSet<String>()
        val stack = ArrayDeque(startIds)
        while (stack.isNotEmpty()) {
            val nodeId = stack.removeLast()
            if (nodeId in visited) continue
            visited.add(nodeId)
            if (nodeId in textNodeSet) {
                found.add(nodeId)
                continue
            }
            val node = workflow[nodeId] ?: continue
            if (node.classType in CONDITIONING_BARRIER_NODES) continue
            for (value in node.inputs.values) {
                val referenced = referenceNodeId(value)
                if (referenced != null && referenced !in visited) stack.addLast(referenced)
            }
        }
        return found
    }

    // ===================== /object_info 辅助 =====================

    /** `/object_info` 中该节点该输入的定义；用于取类型、范围与选项。 */
    internal class ObjectInfoInput(
        val type: Any?,
        val options: List<Any?>?,
        val min: Double?,
        val max: Double?,
        val step: Double?,
    )

    private fun objectInfoEntry(
        objectInfo: Map<String, Any?>?,
        classType: String,
    ): Map<*, *>? = objectInfo?.get(classType) as? Map<*, *>

    internal fun objectInfoInput(
        objectInfo: Map<String, Any?>?,
        classType: String,
        inputName: String,
    ): ObjectInfoInput? {
        val entry = objectInfoEntry(objectInfo, classType) ?: return null
        val input = entry["input"] as? Map<*, *> ?: return null
        val definition = input[inputName] as? List<*> ?: return null
        if (definition.isEmpty()) return null
        val type = definition[0]
        val config = definition.getOrNull(1) as? Map<*, *>
        var options: List<Any?>? = if (type is List<*>) type else null
        var min: Double? = null
        var max: Double? = null
        var step: Double? = null
        if (config != null) {
            min = (config["min"] as? Number)?.toDouble()
            max = (config["max"] as? Number)?.toDouble()
            step = (config["step"] as? Number)?.toDouble()
            if (config["options"] is List<*>) options = config["options"] as List<Any?>
        }
        return ObjectInfoInput(type, options, min, max, step)
    }

    /** 节点类型是否存在于 /object_info；无 objectInfo 时返回 null 表示无法校验。 */
    private fun nodeTypeKnown(objectInfo: Map<String, Any?>?, classType: String): Boolean? {
        if (objectInfo == null) return null
        return objectInfo.containsKey(classType)
    }

    private fun jsTypeOf(value: Any?): ComfyParameterType = when (value) {
        is Number -> ComfyParameterType.Number
        is Boolean -> ComfyParameterType.Boolean
        is String -> ComfyParameterType.Text
        else -> ComfyParameterType.Text
    }

    /** 数字按字面量输出（PC 直接模板串接 JS number）。 */
    private fun numText(value: Number): String = if (value is RawNumber) value.literal else value.toString()

    private fun buildParameter(
        nodeId: String,
        classType: String,
        inputName: String,
        label: String,
        value: Any?,
        objectInfo: Map<String, Any?>?,
        advanced: Boolean = false,
        fallbackType: ComfyParameterType? = null,
    ): ComfyWorkflowParameter {
        val info = objectInfoInput(objectInfo, classType, inputName)
        var type: ComfyParameterType = fallbackType ?: jsTypeOf(value)
        if (info != null) {
            type = when {
                info.options != null && info.options.isNotEmpty() -> ComfyParameterType.Select
                info.type == "INT" || info.type == "FLOAT" -> ComfyParameterType.Number
                info.type == "BOOLEAN" -> ComfyParameterType.Boolean
                info.type == "STRING" && fallbackType == ComfyParameterType.Select -> ComfyParameterType.Select
                else -> type
            }
        } else if (fallbackType != null) {
            type = fallbackType
        }
        return ComfyWorkflowParameter(
            id = "$nodeId.$inputName",
            nodeId = nodeId,
            inputName = inputName,
            label = label,
            type = type,
            workflowValue = value,
            options = info?.options,
            min = info?.min,
            max = info?.max,
            step = info?.step,
            required = true,
            advanced = advanced,
        )
    }

    private fun analyzeSamplerGroup(
        nodeId: String,
        node: ComfyNode,
        objectInfo: Map<String, Any?>?,
    ): ComfyWorkflowParameterGroup? {
        val parameters = mutableListOf<ComfyWorkflowParameter>()
        for ((inputName, label, specType) in SAMPLER_PARAM_SPECS) {
            if (!node.inputs.containsKey(inputName)) continue
            val value = node.inputs[inputName]
            if (isReference(value)) continue
            parameters.add(
                buildParameter(
                    nodeId, node.classType, inputName, label, value,
                    objectInfo, inputName in ADVANCED_SAMPLER_PARAMS, specType,
                ),
            )
        }
        if (parameters.isEmpty()) return null
        return ComfyWorkflowParameterGroup(
            id = nodeId,
            nodeId = nodeId,
            classType = node.classType,
            title = nodeLabel(nodeId, node),
            stage = ComfyParameterStage.Sampling,
            parameters = parameters,
        )
    }

    /** 分析已规范化的 API 工作流（纯函数）。 */
    fun analyze(workflow: ComfyWorkflow, objectInfo: Map<String, Any?>? = null): ComfyWorkflowAnalysis {
        val allIds = workflow.keys.toList()
        val warnings = mutableListOf<ComfyWorkflowWarning>()

        val imageOutputIds = allIds.filter { workflow.getValue(it).classType in ComfyWorkflowCodec.IMAGE_OUTPUT_NODES }
        val videoOutputIds = allIds.filter { workflow.getValue(it).classType in VIDEO_OUTPUT_NODES }

        var kind = ComfyWorkflowKind.Unknown
        if (videoOutputIds.isNotEmpty()) {
            kind = ComfyWorkflowKind.Video
        } else if (imageOutputIds.isNotEmpty()) {
            val reachableFromImage = collectReachable(workflow, imageOutputIds)
            val needsImage = reachableFromImage.any { workflow.getValue(it).classType in IMAGE_INPUT_NODES }
            kind = if (needsImage) ComfyWorkflowKind.ImageToImage else ComfyWorkflowKind.TextToImage
        }

        if (imageOutputIds.isEmpty() && videoOutputIds.isEmpty()) {
            warnings.add(
                ComfyWorkflowWarning(
                    ComfyWorkflowWarningCode.NoOutput,
                    "工作流没有图片输出节点（SaveImage / PreviewImage / SaveImageAdvanced）",
                ),
            )
        }

        val outputIds = if (imageOutputIds.isNotEmpty()) imageOutputIds else videoOutputIds
        val reachable = collectReachable(workflow, outputIds)

        val unreachable = allIds.filter { it !in reachable }
        if (unreachable.isNotEmpty()) {
            warnings.add(
                ComfyWorkflowWarning(
                    ComfyWorkflowWarningCode.UnreachableNodes,
                    "有 ${unreachable.size} 个节点未连接到输出，已忽略",
                    unreachable,
                ),
            )
        }

        val reachableIds = allIds.filter { it in reachable }
        val samplers = reachableIds.filter { workflow.getValue(it).classType in SAMPLER_NODES }

        val promptInputsByNode = LinkedHashMap<String, List<Pair<String, String>>>()
        for (id in reachableIds) {
            val inputs = promptInputs(workflow.getValue(id))
            if (inputs.isNotEmpty()) promptInputsByNode[id] = inputs
        }
        val textNodes = promptInputsByNode.keys.toList()
        val textNodeSet = textNodes.toSet()

        // 采样器的 positive / negative 输入指向 conditioning，中间可能隔着
        // ConditioningCombine、ConditioningSetArea 等节点，需沿条件链回溯到文本节点。
        val positiveStartIds = mutableListOf<String>()
        for (id in samplers) {
            val referenced = referenceNodeId(workflow.getValue(id).inputs["positive"])
            if (referenced != null) positiveStartIds.add(referenced)
        }
        // negative 输入也可能出现在 Guider 等节点上，故对全部可达节点扫描。
        val negativeStartIds = mutableListOf<String>()
        for (id in reachableIds) {
            val node = workflow.getValue(id)
            for (inputName in listOf("negative", "negative_prompt")) {
                val referenced = referenceNodeId(node.inputs[inputName])
                if (referenced != null) negativeStartIds.add(referenced)
            }
        }

        val samplerNegativeIds = collectPromptNodes(workflow, negativeStartIds, textNodeSet).toMutableSet()
        // 采样器未声明 negative 时，用节点标题兜底识别负面文本节点。
        if (samplerNegativeIds.isEmpty()) {
            for (id in textNodes) {
                if (hasNegativeTitleHint(workflow.getValue(id))) samplerNegativeIds.add(id)
            }
        }
        val samplerPositiveIds = collectPromptNodes(workflow, positiveStartIds, textNodeSet)

        // 采样器引用可唯一确定时以它为准；无法确定时退回「可达且非负面」的文本节点集合。
        val resolvedPositiveIds = if (samplerPositiveIds.isNotEmpty()) {
            textNodes.filter { it in samplerPositiveIds && it !in samplerNegativeIds }
        } else {
            textNodes.filter { it !in samplerNegativeIds }
        }

        val promptBindings = mutableListOf<ComfyWorkflowBinding>()
        for (id in resolvedPositiveIds) {
            for ((inputName, value) in promptInputsByNode[id] ?: emptyList()) {
                promptBindings.add(
                    ComfyWorkflowBinding(
                        role = ComfyBindingRole.Positive,
                        nodeId = id,
                        inputName = inputName,
                        workflowValue = value,
                        title = workflow.getValue(id).title,
                    ),
                )
            }
        }
        for (id in textNodes) {
            if (id !in samplerNegativeIds) continue
            for ((inputName, value) in promptInputsByNode[id] ?: emptyList()) {
                promptBindings.add(
                    ComfyWorkflowBinding(
                        role = ComfyBindingRole.Negative,
                        nodeId = id,
                        inputName = inputName,
                        workflowValue = value,
                        title = workflow.getValue(id).title,
                    ),
                )
            }
        }

        val positiveBindingCount = promptBindings.count { it.role == ComfyBindingRole.Positive }
        if (positiveBindingCount == 0) {
            warnings.add(ComfyWorkflowWarning(ComfyWorkflowWarningCode.NoPrompt, "未找到可写入的正面提示词入口"))
        } else if (positiveBindingCount > 1) {
            warnings.add(
                ComfyWorkflowWarning(
                    ComfyWorkflowWarningCode.AmbiguousPrompt,
                    "有 $positiveBindingCount 个候选正面提示词输入，需要确认绑定的入口",
                    resolvedPositiveIds,
                ),
            )
        }

        val outputBindings = outputIds.map { id ->
            ComfyWorkflowBinding(
                role = ComfyBindingRole.Output,
                nodeId = id,
                inputName = "images",
                title = workflow.getValue(id).title,
            )
        }
        if (outputIds.size > 1) {
            warnings.add(
                ComfyWorkflowWarning(
                    ComfyWorkflowWarningCode.AmbiguousOutput,
                    "有 ${outputIds.size} 个输出节点，需要确认使用的输出",
                    outputIds,
                ),
            )
        }

        // ---- 参数分组 ----
        val parameterGroups = mutableListOf<ComfyWorkflowParameterGroup>()

        for (id in reachableIds) {
            val node = workflow.getValue(id)
            if (node.classType !in LATENT_SIZE_NODES) continue
            val width = node.inputs["width"]
            val height = node.inputs["height"]
            if (width !is Number || height !is Number) continue
            val widthInfo = objectInfoInput(objectInfo, node.classType, "width")
            val heightInfo = objectInfoInput(objectInfo, node.classType, "height")
            parameterGroups.add(
                ComfyWorkflowParameterGroup(
                    id = id,
                    nodeId = id,
                    classType = node.classType,
                    title = nodeLabel(id, node),
                    stage = ComfyParameterStage.Output,
                    parameters = listOf(
                        ComfyWorkflowParameter(
                            id = "$id.width",
                            nodeId = id,
                            inputName = "width",
                            label = "尺寸",
                            type = ComfyParameterType.Size,
                            workflowValue = "${numText(width)}x${numText(height)}",
                            pairedInputName = "height",
                            pairedWorkflowValue = height,
                            min = widthInfo?.min,
                            max = widthInfo?.max,
                            step = widthInfo?.step,
                            required = true,
                        ).let { param -> if (heightInfo?.max != null) param.copy(max = heightInfo.max) else param },
                    ),
                ),
            )
        }

        for (id in samplers) {
            val group = analyzeSamplerGroup(id, workflow.getValue(id), objectInfo)
            if (group != null) parameterGroups.add(group)
        }

        // ---- 模型依赖与模型侧可调项 ----
        val dependencies = mutableListOf<ComfyWorkflowDependency>()
        val usageIndex = HashMap<String, MutableList<ComfyUsage>>()
        for (id in reachableIds) {
            val node = workflow.getValue(id)
            for ((inputName, value) in node.inputs) {
                val referenced = referenceNodeId(value) ?: continue
                usageIndex.getOrPut(referenced) { mutableListOf() }.add(ComfyUsage(id, inputName))
            }
        }

        for (id in reachableIds) {
            val node = workflow.getValue(id)
            val spec = LOADER_SPECS[node.classType] ?: continue
            val value = node.inputs[spec.inputName]
            if (value !is String) continue
            val info = objectInfoInput(objectInfo, node.classType, spec.inputName)
            val options = info?.options?.filterIsInstance<String>()
            dependencies.add(
                ComfyWorkflowDependency(
                    nodeId = id,
                    inputName = spec.inputName,
                    classType = node.classType,
                    label = spec.label,
                    value = value,
                    provides = spec.provides,
                    usedBy = usageIndex[id] ?: emptyList(),
                    options = options?.takeIf { it.isNotEmpty() },
                    available = options?.takeIf { it.isNotEmpty() }?.contains(value),
                ),
            )
            if (!options.isNullOrEmpty() && value !in options) {
                warnings.add(
                    ComfyWorkflowWarning(
                        ComfyWorkflowWarningCode.MissingModel,
                        "${spec.label} 模型 $value 不在该 Loader 的可用列表中",
                        listOf(id),
                    ),
                )
            }

            if (spec.tuning.isNotEmpty()) {
                val parameters = mutableListOf<ComfyWorkflowParameter>()
                for (tuning in spec.tuning) {
                    if (!node.inputs.containsKey(tuning.inputName)) continue
                    val tuningValue = node.inputs[tuning.inputName]
                    if (isReference(tuningValue)) continue
                    parameters.add(
                        buildParameter(
                            id, node.classType, tuning.inputName, tuning.label, tuningValue,
                            objectInfo, false, tuning.type,
                        ),
                    )
                }
                if (parameters.isNotEmpty()) {
                    parameterGroups.add(
                        ComfyWorkflowParameterGroup(
                            id = id,
                            nodeId = id,
                            classType = node.classType,
                            title = nodeLabel(id, node),
                            stage = ComfyParameterStage.Model,
                            parameters = parameters,
                        ),
                    )
                }
            }
        }

        if (kind == ComfyWorkflowKind.Video) {
            warnings.add(ComfyWorkflowWarning(ComfyWorkflowWarningCode.VideoWorkflow, "这是视频工作流，不能作为图片模型保存"))
        }
        if (kind == ComfyWorkflowKind.ImageToImage) {
            warnings.add(ComfyWorkflowWarning(ComfyWorkflowWarningCode.RequiresImageInput, "这是图生图工作流，需要提供输入图片"))
        }
        if (samplers.size > 1) {
            warnings.add(
                ComfyWorkflowWarning(
                    ComfyWorkflowWarningCode.MultiStage,
                    "检测到 ${samplers.size} 个采样阶段，参数将按节点分组",
                    samplers,
                ),
            )
        }

        // ---- 节点类型校验（依赖 /object_info）----
        if (objectInfo != null) {
            val unknownNodes = reachableIds.filter { nodeTypeKnown(objectInfo, workflow.getValue(it).classType) == false }
            if (unknownNodes.isNotEmpty()) {
                warnings.add(
                    ComfyWorkflowWarning(
                        ComfyWorkflowWarningCode.UnknownNode,
                        "有 ${unknownNodes.size} 个节点类型在当前 ComfyUI 中不存在",
                        unknownNodes,
                    ),
                )
            }
        }

        val compatible = kind == ComfyWorkflowKind.TextToImage &&
            imageOutputIds.isNotEmpty() &&
            positiveBindingCount > 0 &&
            warnings.none { it.code == ComfyWorkflowWarningCode.UnknownNode || it.code == ComfyWorkflowWarningCode.MissingModel }

        return ComfyWorkflowAnalysis(
            kind = kind,
            nodeCount = allIds.size,
            compatible = compatible,
            promptBindings = promptBindings,
            outputBindings = outputBindings,
            parameterGroups = parameterGroups,
            dependencies = dependencies,
            warnings = warnings,
        )
    }

    /**
     * 从工作流推断配置初值（PC `inferSettings`）：导入向导把识别到的
     * 尺寸/步数/CFG/采样器/调度器/模型/负面提示词回填到界面。
     */
    data class InferredSettings(
        val size: String? = null,
        val steps: Long? = null,
        val cfgScale: Double? = null,
        val sampler: String? = null,
        val scheduler: String? = null,
        val model: String? = null,
        val negativePrompt: String? = null,
    )

    fun inferSettings(workflow: ComfyWorkflow): InferredSettings {
        var size: String? = null
        var steps: Long? = null
        var cfgScale: Double? = null
        var sampler: String? = null
        var scheduler: String? = null
        var model: String? = null
        var negativePrompt: String? = null

        val negativeTextNodeIds = HashSet<String>()
        for (node in workflow.values) {
            if (node.classType != "KSampler" && node.classType != "KSamplerAdvanced") continue
            val negative = node.inputs["negative"]
            if (negative is List<*> && negative.isNotEmpty() && negative[0] is String) {
                negativeTextNodeIds.add(negative[0] as String)
            }
        }
        for (node in workflow.values) {
            val width = node.inputs["width"]
            val height = node.inputs["height"]
            if ((node.classType == "EmptyLatentImage" || node.classType == "EmptySD3LatentImage") &&
                width is Number && height is Number && size == null
            ) {
                size = "${width.toLong()}x${height.toLong()}"
            }
            if (node.classType == "KSampler" || node.classType == "KSamplerAdvanced") {
                if (steps == null) (node.inputs["steps"] as? Number)?.let { steps = it.toLong() }
                if (cfgScale == null) (node.inputs["cfg"] as? Number)?.let { cfgScale = it.toDouble() }
                if (sampler == null) sampler = node.inputs["sampler_name"] as? String
                if (scheduler == null) scheduler = node.inputs["scheduler"] as? String
            }
            if (node.classType == "CheckpointLoaderSimple" && model == null) {
                model = node.inputs["ckpt_name"] as? String
            }
        }
        for (id in negativeTextNodeIds) {
            val node = workflow[id]
            if (node?.classType == "CLIPTextEncode" && negativePrompt == null) {
                negativePrompt = node.inputs["text"] as? String
            }
        }
        return InferredSettings(size, steps, cfgScale, sampler, scheduler, model, negativePrompt)
    }
}
