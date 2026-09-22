package com.qingyu.companion.imagegen

/**
 * ComfyUI 运行时工作流构建与参数覆盖（PC `electron/services/imageGen.ts` 的
 * `customComfyWorkflow` / `buildComfyWorkflow` / `applyWorkflowOverrides` 等价纯逻辑）。
 *
 * 事实来源规则（与 PC 一致）：
 * - 用户保存的绑定（[ComfyWorkflowBindings]）是提示词入口的唯一事实来源；
 *   旧配置没有绑定时复用导入分析器推断，避免「配置页识别正确、运行时又用另一套规则猜错」；
 * - 只随机化可达输出的**第一个采样阶段**，后续阶段继承其种子；
 * - 用户显式保存的 overrides **最后应用**，优先级高于随机化。
 */
object ComfyWorkflowOverrides {

    private val SAMPLER_CLASS_TYPES: Set<String> =
        setOf("KSampler", "KSamplerAdvanced", "SamplerCustom", "SamplerCustomAdvanced")

    /** 判断输入值是否为 `["节点ID", 槽位]` 形式的引用。 */
    fun isNodeReference(value: Any?): Boolean = value is List<*> && value.size >= 2 && value[0] is String

    /**
     * 解析本次请求的负面提示词写入值。
     *
     * 返回 null 表示「保留工作流原有负面提示词」（PC 的 `undefined` 语义）；
     * 空字符串表示显式清空。[requestNegative] 非 null 时优先（本次请求显式指定）。
     */
    fun resolveNegativePrompt(
        mode: ComfyNegativePromptMode?,
        preset: String?,
        requestNegative: String?,
    ): String? = when {
        requestNegative != null -> requestNegative
        mode == ComfyNegativePromptMode.Preset -> preset ?: ""
        mode == ComfyNegativePromptMode.Empty -> ""
        else -> null
    }

    /** 占位符机制：兼容用户在自定义节点里手写的 `{{prompt}}` 等标记（非主要通道）。 */
    internal fun replacePlaceholders(value: Any?, replacements: Map<String, Any?>): Any? = when {
        value is List<*> -> value.map { replacePlaceholders(it, replacements) }
        value is Map<*, *> -> LinkedHashMap<String, Any?>().apply {
            for ((key, item) in value) {
                put(key?.toString() ?: continue, replacePlaceholders(item, replacements))
            }
        }
        value !is String -> value
        replacements.containsKey(value) -> replacements[value]
        else -> replacements.entries.fold(value) { acc, (key, replacement) ->
            acc.replace(key, replacement?.toString() ?: "")
        }
    }

    /**
     * 应用用户保存的节点级覆盖。
     *
     * 键格式为 `节点ID.输入名`（如 `57:3.steps`），节点 ID 可能含 `:`，
     * 故按最后一个 `.` 切分。只写目标节点的目标输入，不影响其他节点；
     * 未知节点/无 `.` 的键静默忽略（与 PC 一致）。
     */
    fun applyOverrides(workflow: ComfyWorkflow, overrides: Map<String, Any?>) {
        for ((key, value) in overrides) {
            val separator = key.lastIndexOf('.')
            if (separator <= 0) continue
            val nodeId = key.substring(0, separator)
            val inputName = key.substring(separator + 1)
            val node = workflow[nodeId] ?: continue
            node.inputs[inputName] = value
        }
    }

    /**
     * 找出可达输出的第一个采样阶段。
     *
     * 多阶段工作流（基础生成 → 精修 → 放大）中只有基础阶段接收随机种子，
     * 后续阶段继承前一阶段结果。判据是「latent 输入不引用另一个采样器」，
     * 即链条的入口阶段；找不到时返回 null，调用方退回随机化全部阶段。
     */
    fun firstReachableSamplerId(workflow: ComfyWorkflow): String? {
        val outputIds = workflow.filterValues { it.classType in ComfyWorkflowCodec.IMAGE_OUTPUT_NODES }.keys.toList()
        if (outputIds.isEmpty()) return null
        val reachable = collectReachable(workflow, outputIds)
        for (nodeId in workflow.keys) {
            val node = workflow.getValue(nodeId)
            if (nodeId !in reachable || node.classType !in SAMPLER_CLASS_TYPES) continue
            val upstreamIsSampler = listOf("latent_image", "samples", "latent").any { inputName ->
                val value = node.inputs[inputName]
                isNodeReference(value) &&
                    SAMPLER_CLASS_TYPES.contains(workflow[(value as List<*>)[0].toString()]?.classType)
            }
            if (!upstreamIsSampler) return nodeId
        }
        return null
    }

    private fun collectReachable(workflow: ComfyWorkflow, outputIds: List<String>): Set<String> {
        val reachable = HashSet<String>()
        val stack = ArrayDeque(outputIds)
        while (stack.isNotEmpty()) {
            val nodeId = stack.removeLast()
            if (nodeId in reachable) continue
            val node = workflow[nodeId] ?: continue
            reachable.add(nodeId)
            for (value in node.inputs.values) {
                if (isNodeReference(value)) {
                    val referenced = (value as List<*>)[0].toString()
                    if (referenced !in reachable) stack.addLast(referenced)
                }
            }
        }
        return reachable
    }

    /**
     * 构建可执行的 ComfyUI 工作流（PC `buildComfyWorkflow` + `customComfyWorkflow`）。
     *
     * @param workflowJson 可执行工作流快照（API 格式，或 `{prompt:{...}}` 包装；画布格式请先经
     *   [ComfyWorkflowCodec.normalize] 转换保存）。工作流是配置的唯一事实来源，无内置回退。
     * @param prompt 提示词清洗后的正面提示词。
     * @param negativePrompt [resolveNegativePrompt] 的返回值；null 表示保留工作流原值。
     * @param seed 随机种子（由调用侧注入，便于测试确定性）。
     */
    fun buildRunnableWorkflow(
        workflowJson: String,
        prompt: String,
        negativePrompt: String?,
        bindings: ComfyWorkflowBindings?,
        overrides: Map<String, Any?>?,
        width: Int,
        height: Int,
        seed: Long,
    ): ComfyWorkflow {
        if (workflowJson.isBlank()) {
            throw ImageGenConfigException("ComfyUI 未配置工作流，请在 设置 -> API -> 生图 中选择或粘贴 API 格式工作流")
        }
        val parsed = try {
            parseJsonElement(workflowJson)
        } catch (err: Exception) {
            throw ImageGenConfigException("ComfyUI 工作流 JSON 无效: ${err.message ?: err}")
        }
        val root = jsonToValue(parsed)
        if (root !is Map<*, *>) throw ImageGenConfigException("ComfyUI 工作流必须是“API 格式”的节点对象")
        val rawWorkflow = root["prompt"] as? Map<*, *> ?: root

        // 深拷贝快照，避免修改调用方持有的配置对象。
        val copied = deepCopyMap(rawWorkflow)
        val workflow: ComfyWorkflow = LinkedHashMap()
        for ((id, value) in copied) {
            val nodeId = id?.toString() ?: continue
            workflow[nodeId] = ComfyWorkflowCodec.apiNodeFrom(
                value,
                nodeId,
                "ComfyUI 工作流节点 $nodeId 格式无效，请导出 API 格式工作流",
            )
        }

        val replaced = replacePlaceholders(
            workflowAsValue(workflow),
            linkedMapOf<String, Any?>(
                "{{prompt}}" to prompt,
                "{{negative_prompt}}" to (negativePrompt ?: ""),
                "{{width}}" to width,
                "{{height}}" to height,
                "{{seed}}" to seed,
            ),
        )
        val replacedWorkflow: ComfyWorkflow = LinkedHashMap()
        for ((id, value) in (replaced as Map<*, *>)) {
            val nodeId = id?.toString() ?: continue
            replacedWorkflow[nodeId] = ComfyWorkflowCodec.apiNodeFrom(
                value,
                nodeId,
                "ComfyUI 工作流节点 $nodeId 格式无效，请导出 API 格式工作流",
            )
        }

        // 用户绑定是唯一事实来源；旧配置没有绑定时复用导入分析器推断。
        fun configuredTargets(role: ComfyBindingRole): List<ComfyPromptTarget>? {
            val b = bindings ?: return null
            val exact = when (role) {
                ComfyBindingRole.Positive -> b.positivePromptTargets
                ComfyBindingRole.Negative -> b.negativePromptTargets
                ComfyBindingRole.Output -> null
            }
            if (exact != null) return exact
            val legacy = when (role) {
                ComfyBindingRole.Positive -> b.positivePromptNodeIds
                ComfyBindingRole.Negative -> b.negativePromptNodeIds
                ComfyBindingRole.Output -> null
            } ?: return null
            return legacy.map { ComfyPromptTarget(it, "text") }
        }

        val analysis = ComfyWorkflowAnalyzer.analyze(replacedWorkflow)
        fun inferredTargets(role: ComfyBindingRole): List<ComfyPromptTarget> =
            analysis.promptBindings
                .filter { it.role == role && it.inputName != null }
                .map { ComfyPromptTarget(it.nodeId, it.inputName!!) }

        val positiveTargets = configuredTargets(ComfyBindingRole.Positive) ?: inferredTargets(ComfyBindingRole.Positive)
        val negativeTargets = configuredTargets(ComfyBindingRole.Negative) ?: inferredTargets(ComfyBindingRole.Negative)

        fun writeTargets(targets: List<ComfyPromptTarget>, value: String, label: String) {
            for (target in targets) {
                val node = replacedWorkflow[target.nodeId]
                if (node == null || !node.inputs.containsKey(target.inputName)) {
                    throw ImageGenConfigException(
                        "ComfyUI ${label}入口 ${target.nodeId}.${target.inputName} 已失效，请重新选择工作流入口",
                    )
                }
                node.inputs[target.inputName] = value
            }
        }

        if (positiveTargets.isEmpty()) {
            throw ImageGenConfigException("ComfyUI 未选择正面提示词入口，请在生图配置中确认")
        }
        writeTargets(positiveTargets, prompt, "正面提示词")
        if (negativePrompt != null) writeTargets(negativeTargets, negativePrompt, "负面提示词")

        // 只随机化可达输出的第一个采样阶段，后续阶段继承其种子。
        // 未显式指定种子覆盖时，随机化结果生效。
        val seedStageId = firstReachableSamplerId(replacedWorkflow)
        for ((nodeId, node) in replacedWorkflow) {
            if (node.classType !in SAMPLER_CLASS_TYPES) continue
            if (seedStageId != null && nodeId != seedStageId) continue
            if (node.inputs.containsKey("seed")) node.inputs["seed"] = seed
            if (node.inputs.containsKey("noise_seed")) node.inputs["noise_seed"] = seed
        }

        // 用户显式保存的覆盖最后应用，优先级高于随机化。
        if (overrides != null) applyOverrides(replacedWorkflow, overrides)

        return replacedWorkflow
    }

    private fun workflowAsValue(workflow: ComfyWorkflow): Map<String, Any?> {
        val root = LinkedHashMap<String, Any?>()
        for ((nodeId, node) in workflow) {
            val nodeMap = LinkedHashMap<String, Any?>()
            nodeMap["class_type"] = node.classType
            nodeMap["inputs"] = node.inputs
            if (node.title != null) nodeMap["_meta"] = linkedMapOf("title" to node.title)
            root[nodeId] = nodeMap
        }
        return root
    }

    private fun deepCopyMap(raw: Map<*, *>): Map<String, Any?> {
        val copy = LinkedHashMap<String, Any?>()
        for ((key, value) in raw) {
            copy[key?.toString() ?: continue] = deepCopyValue(value)
        }
        return copy
    }

    private fun deepCopyValue(value: Any?): Any? = when (value) {
        is Map<*, *> -> deepCopyMap(value)
        is List<*> -> value.map { deepCopyValue(it) }
        else -> value
    }
}
