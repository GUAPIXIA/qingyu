package com.qingyu.companion.imagegen

import java.security.MessageDigest

/**
 * ComfyUI 工作流编解码（PC `electron/services/comfyWorkflow.ts` 的纯逻辑部分）。
 *
 * 覆盖：
 * - `normalizeComfyWorkflow`：API 格式直接规范化；前端画布格式转换为 /prompt 接受的 API 节点对象；
 * - `hashComfyWorkflow`：快照哈希（**平台本地变更检测用**，非跨端契约字段）；
 * - `hasImageOutput`：图片输出节点白名单。
 *
 * 刻意不做（PC 专有半边）：本地工作流目录扫描、Comfy Desktop installations 发现、文件对话框。
 */
object ComfyWorkflowCodec {

    /** 图片输出节点白名单（PC `IMAGE_OUTPUT_NODES`）。 */
    val IMAGE_OUTPUT_NODES: Set<String> = setOf("SaveImage", "PreviewImage", "SaveImageAdvanced")

    private val FRONTEND_ONLY_NODES: Set<String> = setOf("MarkdownNote", "Note", "PrimitiveNode", "Reroute")

    /** “undefined”语义哨兵：JSON null 是合法值，与“该槽位没有值”必须区分。 */
    private val UNDEFINED = Any()

    data class NormalizedWorkflow(val workflow: ComfyWorkflow, val converted: Boolean)

    /** 从 JSON 文本规范化工作流。 */
    fun normalizeFromText(text: String): NormalizedWorkflow {
        val parsed = try {
            parseJsonElement(text)
        } catch (err: Exception) {
            throw ImageGenConfigException("ComfyUI 工作流 JSON 无效: ${err.message ?: err}")
        }
        return normalize(jsonToValue(parsed))
    }

    /** 把任意 ComfyUI 工作流（画布或 API 格式）规范化为 API 节点对象。 */
    fun normalize(raw: Any?): NormalizedWorkflow {
        if (raw !is Map<*, *>) throw ImageGenConfigException("工作流 JSON 顶层必须是对象")
        if (raw["nodes"] is List<*>) {
            return NormalizedWorkflow(CanvasConverter(raw).convert(), converted = true)
        }
        val candidate = raw["prompt"] as? Map<*, *> ?: raw
        val workflow: ComfyWorkflow = LinkedHashMap()
        for ((id, value) in candidate) {
            val nodeId = id?.toString() ?: continue
            workflow[nodeId] = apiNodeFrom(value, nodeId, "节点 $nodeId 不是有效的 ComfyUI API 节点")
        }
        if (workflow.isEmpty()) throw ImageGenConfigException("工作流中没有可执行节点")
        return NormalizedWorkflow(workflow, converted = false)
    }

    /** API 节点形状校验（错误文案可按调用路径定制，PC 两处文案不同）。 */
    internal fun apiNodeFrom(value: Any?, nodeId: String, invalidMessage: String): ComfyNode {
        if (value !is Map<*, *>) throw ImageGenConfigException(invalidMessage)
        val classType = value["class_type"] as? String ?: throw ImageGenConfigException(invalidMessage)
        val inputs = value["inputs"]
        if (inputs !is Map<*, *>) throw ImageGenConfigException(invalidMessage)
        val title = (value["_meta"] as? Map<*, *>)?.get("title") as? String
        val copied = LinkedHashMap<String, Any?>()
        for ((key, item) in inputs) {
            copied[key as? String ?: throw ImageGenConfigException(invalidMessage)] = item
        }
        return ComfyNode(classType, copied, title)
    }

    /** 工作流列表的可读性过滤：必须存在图片输出节点。 */
    fun hasImageOutput(workflow: ComfyWorkflow): Boolean =
        workflow.values.any { it.classType in IMAGE_OUTPUT_NODES }

    /**
     * 快照哈希：sha256(canonical JSON) 前 16 位十六进制。
     *
     * 节点键序固定为 `class_type / inputs / _meta?`，输入表保持原顺序；
     * 与 PC `JSON.stringify` 字面序哈希用途一致（检测工作流是否被改过），但不要求跨端字节相等。
     */
    fun hashWorkflow(workflow: ComfyWorkflow): String {
        val digest = MessageDigest.getInstance("SHA-256")
        val bytes = workflowToJson(workflow).toByteArray(Charsets.UTF_8)
        return digest.digest(bytes).joinToString("") { "%02x".format(it) }.take(16)
    }

    /** 规范化序列化（供 /prompt 请求体与哈希使用）。 */
    fun workflowToJson(workflow: ComfyWorkflow): String {
        val root = LinkedHashMap<String, Any?>()
        for ((nodeId, node) in workflow) {
            val nodeMap = LinkedHashMap<String, Any?>()
            nodeMap["class_type"] = node.classType
            nodeMap["inputs"] = node.inputs
            if (node.title != null) nodeMap["_meta"] = linkedMapOf("title" to node.title)
            root[nodeId] = nodeMap
        }
        return encodeJsonElement(valueToJson(root))
    }

    // ===================== 画布 → API 转换 =====================

    private class GraphLink(
        val id: Any,
        val originId: Any,
        val originSlot: Int,
        val targetId: Any,
        val targetSlot: Int,
    )

    /** 数字槽位读取（画布 JSON 的数字经 [RawNumber] 保留字面量）。 */
    private fun asInt(value: Any?): Int? = when (value) {
        is RawNumber -> value.toInt()
        is Number -> value.toInt()
        is String -> value.toIntOrNull()
        else -> null
    }

    private fun normalizeLink(raw: Any?): GraphLink? {
        if (raw is List<*> && raw.size >= 5) {
            val id = raw[0] ?: return null
            val originId = raw[1] ?: return null
            val targetId = raw[3] ?: return null
            return GraphLink(id, originId, asInt(raw[2]) ?: 0, targetId, asInt(raw[4]) ?: 0)
        }
        if (raw !is Map<*, *>) return null
        val id = raw["id"] ?: return null
        val originId = raw["origin_id"] ?: return null
        val targetId = raw["target_id"] ?: return null
        return GraphLink(id, originId, asInt(raw["origin_slot"]) ?: 0, targetId, asInt(raw["target_slot"]) ?: 0)
    }

    /** 将 ComfyUI 前端画布工作流转换为 /prompt 接受的 API 节点对象。 */
    private class CanvasConverter(private val raw: Map<*, *>) {
        private val definitions = HashMap<String, Map<*, *>>()
        private val flattened = HashMap<String, List<Any?>>()
        private val result: ComfyWorkflow = LinkedHashMap()

        init {
            val rawDefinitions = (raw["definitions"] as? Map<*, *>)?.get("subgraphs") as? List<*>
            for (item in rawDefinitions ?: emptyList<Any?>()) {
                if (item is Map<*, *> && item["id"] != null && item["nodes"] is List<*>) {
                    definitions[item["id"].toString()] = item
                }
            }
        }

        fun convert(): ComfyWorkflow {
            convertGraph(raw, "", emptyList())
            return result
        }

        private fun widgetValue(node: Map<*, *>, input: Map<*, *>, inputIndex: Int): Any? {
            val named = node["widgets_values_named"] as? Map<*, *>
            val name = (input["widget"] as? Map<*, *>)?.get("name") as? String ?: input["name"] as? String
            if (name != null && named != null && named.containsKey(name)) return named[name]

            // 旧版画布格式没有 widgets_values_named。大多数节点的 widget 顺序与输入顺序一致。
            val allInputs = (node["inputs"] as? List<*>) ?: emptyList<Any?>()
            val widgetInputs = allInputs.filter { (it as? Map<*, *>)?.get("widget") != null }
            var widgetIndex = widgetInputs.indexOfFirst { it === input }
            // KSampler 的旧画布格式会在 seed 后额外保存 control_after_generate，
            // 但它不出现在 inputs 中，后续 widget 因此需要错开一位。
            val seedIndex = widgetInputs.indexOfFirst { item ->
                val widget = (item as? Map<*, *>)?.get("widget") as? Map<*, *>
                val itemName = widget?.get("name") as? String ?: (item as? Map<*, *>)?.get("name") as? String
                itemName == "seed" || itemName == "noise_seed"
            }
            val values = node["widgets_values"] as? List<*>
            if ((values?.size ?: 0) == widgetInputs.size + 1 && seedIndex >= 0 && widgetIndex > seedIndex) {
                widgetIndex += 1
            }
            return when {
                widgetIndex >= 0 && values != null && widgetIndex < values.size -> values[widgetIndex]
                values != null && inputIndex < values.size -> values[inputIndex]
                else -> UNDEFINED
            }
        }

        private fun resolveOrigin(
            nodes: Map<String, Map<*, *>>,
            links: Map<Any, GraphLink>,
            prefix: String,
            externalInputs: List<Any?>,
            originId: Any?,
            originSlot: Int,
        ): Any? {
            if (originId.toString() == "-10") {
                return if (originSlot in externalInputs.indices) externalInputs[originSlot] else UNDEFINED
            }
            val origin = nodes[originId.toString()]
                ?: throw ImageGenConfigException("工作流连接引用了不存在的节点 $originId")

            val definition = definitions[origin["type"]?.toString()]
            if (definition != null) {
                val cacheKey = "$prefix${origin["id"]}"
                var outputs = flattened[cacheKey]
                if (outputs == null) {
                    val defInputs = (origin["inputs"] as? List<*>) ?: emptyList<Any?>()
                    val values = defInputs.mapIndexed { index, item ->
                        val input = item as? Map<*, *>
                        val linkId = input?.get("link")
                        if (linkId != null) {
                            val link = links[linkId]
                                ?: throw ImageGenConfigException(
                                    "子工作流输入 ${input?.get("name") ?: index} 的连接无效",
                                )
                            resolveOrigin(nodes, links, prefix, externalInputs, link.originId, link.originSlot)
                        } else {
                            widgetValue(origin, input ?: emptyMap<Any, Any>(), index)
                        }
                    }
                    outputs = convertGraph(definition, "$prefix${origin["id"]}:", values)
                    flattened[cacheKey] = outputs
                }
                return if (originSlot in outputs.indices) outputs[originSlot] else UNDEFINED
            }

            return when (origin["type"]?.toString()) {
                "Reroute" -> {
                    val inputLink = (origin["inputs"] as? List<*>)?.getOrNull(0) as? Map<*, *>
                    val linkId = inputLink?.get("link")
                    val link = if (linkId == null) null else links[linkId]
                    if (link == null) throw ImageGenConfigException("重路由节点 ${origin["id"]} 没有有效输入")
                    resolveOrigin(nodes, links, prefix, externalInputs, link.originId, link.originSlot)
                }
                "PrimitiveNode" -> (origin["widgets_values"] as? List<*>)?.getOrNull(0) ?: UNDEFINED
                else -> listOf("$prefix${origin["id"]}", RawNumber(originSlot.toString()))
            }
        }

        private fun convertGraph(
            graph: Map<*, *>,
            prefix: String,
            externalInputs: List<Any?>,
        ): List<Any?> {
            val nodes = LinkedHashMap<String, Map<*, *>>()
            for (item in (graph["nodes"] as? List<*>) ?: emptyList<Any?>()) {
                if (item is Map<*, *> && item["id"] != null) nodes[item["id"].toString()] = item
            }
            val links = LinkedHashMap<Any, GraphLink>()
            for (item in (graph["links"] as? List<*>) ?: emptyList<Any?>()) {
                val link = normalizeLink(item) ?: continue
                links[link.id] = link
            }

            fun resolve(originId: Any?, originSlot: Int): Any? =
                resolveOrigin(nodes, links, prefix, externalInputs, originId, originSlot)

            // 先展开子工作流，确保被普通节点引用时输出映射已经存在。
            for (node in nodes.values) {
                if (definitions.containsKey(node["type"]?.toString())) resolve(node["id"], 0)
            }

            for (node in nodes.values) {
                val type = node["type"]?.toString() ?: continue
                if (definitions.containsKey(type) || type in FRONTEND_ONLY_NODES) continue
                if (asInt(node["mode"]) == 2) continue // 画布“静音”节点不进入 API 工作流
                val inputs = LinkedHashMap<String, Any?>()
                val nodeInputs = (node["inputs"] as? List<*>) ?: emptyList<Any?>()
                nodeInputs.forEachIndexed { index, item ->
                    val input = item as? Map<*, *> ?: return@forEachIndexed
                    val inputName = input["name"] as? String ?: return@forEachIndexed
                    val linkId = input["link"]
                    if (linkId != null) {
                        val link = links[linkId]
                            ?: throw ImageGenConfigException("节点 ${node["id"]} 的输入 $inputName 连接无效")
                        val value = resolve(link.originId, link.originSlot)
                        if (value !== UNDEFINED) inputs[inputName] = value
                    } else if (input["widget"] != null) {
                        val value = widgetValue(node, input, index)
                        if (value !== UNDEFINED) inputs[inputName] = value
                    }
                }
                val title = node["title"] as? String
                result["$prefix${node["id"]}"] = ComfyNode(type, inputs, title)
            }

            val outputs = HashMap<Int, Any?>()
            for (link in links.values) {
                if (link.targetId.toString() == "-20") {
                    outputs[link.targetSlot] = resolve(link.originId, link.originSlot)
                }
            }
            val maxSlot = outputs.keys.maxOrNull() ?: -1
            return (0..maxSlot).map { slot -> outputs[slot] ?: UNDEFINED }
        }
    }
}
