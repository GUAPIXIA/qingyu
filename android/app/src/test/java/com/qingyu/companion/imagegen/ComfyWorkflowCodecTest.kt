package com.qingyu.companion.imagegen

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.assertThrows
import org.junit.Test

/**
 * S6-04：工作流规范化（API/画布格式）与快照哈希（PC `comfyWorkflow.ts` 纯逻辑等价）。
 */
class ComfyWorkflowCodecTest {

    @Test
    fun `api workflow normalized with number literals preserved`() {
        val json = """
            {"3":{"class_type":"KSampler","inputs":{"seed":42,"steps":20,"model":["4",0]},"_meta":{"title":"采样"}}}
        """.trimIndent()
        val normalized = ComfyWorkflowCodec.normalizeFromText(json)
        assertFalse("API 格式不标记为转换", normalized.converted)
        val node = normalized.workflow.getValue("3")
        assertEquals("class_type 必须保留", "KSampler", node.classType)
        assertEquals("节点标题必须保留", "采样", node.title)
        val seed = node.inputs["seed"] as RawNumber
        assertEquals("数字必须保留原始字面量，避免快照漂移", "42", seed.literal)
        assertTrue("引用形状必须保留", ComfyWorkflowOverrides.isNodeReference(node.inputs["model"]))
        assertTrue(
            "序列化必须回写原始数字字面量",
            ComfyWorkflowCodec.workflowToJson(normalized.workflow).contains("\"seed\":42"),
        )
    }

    @Test
    fun `prompt wrapper accepted`() {
        val json = """{"prompt":{"3":{"class_type":"SaveImage","inputs":{"images":["4",0]}}}}"""
        val normalized = ComfyWorkflowCodec.normalizeFromText(json)
        assertTrue("带 prompt 包装的 API 工作流必须可用", normalized.workflow.containsKey("3"))
    }

    @Test
    fun `invalid workflows rejected with pc messages`() {
        val array = assertThrows(ImageGenConfigException::class.java) {
            ComfyWorkflowCodec.normalizeFromText("[1,2]")
        }
        assertEquals("顶层非对象必须报错", "工作流 JSON 顶层必须是对象", array.message)

        val badNode = assertThrows(ImageGenConfigException::class.java) {
            ComfyWorkflowCodec.normalizeFromText("""{"1":{"inputs":{}}}""")
        }
        assertEquals("缺 class_type 的节点必须报错", "节点 1 不是有效的 ComfyUI API 节点", badNode.message)

        val empty = assertThrows(ImageGenConfigException::class.java) {
            ComfyWorkflowCodec.normalizeFromText("{}")
        }
        assertEquals("空工作流必须报错", "工作流中没有可执行节点", empty.message)

        val broken = assertThrows(ImageGenConfigException::class.java) {
            ComfyWorkflowCodec.normalizeFromText("{不是 JSON")
        }
        assertTrue("坏 JSON 必须报解析失败：${broken.message}", broken.message!!.startsWith("ComfyUI 工作流 JSON 无效"))
    }

    private val canvasJson = """
        {
          "nodes": [
            {"id": 10, "type": "CheckpointLoaderSimple", "inputs": [{"name": "ckpt_name", "widget": {"name": "ckpt_name"}}], "outputs": [{"name": "MODEL"}, {"name": "CLIP"}], "widgets_values": ["model.safetensors"]},
            {"id": 20, "type": "CLIPTextEncode", "title": "Positive", "inputs": [{"name": "clip", "link": 100}, {"name": "text", "widget": {"name": "text"}}], "outputs": [{"name": "CONDITIONING"}], "widgets_values": ["hello"]},
            {"id": 40, "type": "Reroute", "inputs": [{"name": "", "link": 102}], "outputs": [{"name": ""}]},
            {"id": 30, "type": "KSampler", "inputs": [{"name": "model", "link": 101}, {"name": "positive", "link": 103}, {"name": "seed", "widget": {"name": "seed"}}, {"name": "steps", "widget": {"name": "steps"}}], "widgets_values": [42, 20]},
            {"id": 50, "type": "VAELoader", "mode": 2, "inputs": [{"name": "vae_name", "widget": {"name": "vae_name"}}], "widgets_values": ["vae.safetensors"]}
          ],
          "links": [[100, 10, 1, 20, 0], [101, 10, 0, 30, 0], [102, 20, 0, 40, 0], [103, 40, 0, 30, 1]]
        }
    """.trimIndent()

    @Test
    fun `canvas workflow converted to api nodes`() {
        val normalized = ComfyWorkflowCodec.normalizeFromText(canvasJson)
        assertTrue("画布格式必须标记为已转换", normalized.converted)
        val workflow = normalized.workflow
        assertEquals("Reroute 与静音节点不得进入 API 工作流", setOf("10", "20", "30"), workflow.keys)

        val text = workflow.getValue("20")
        assertEquals("节点标题必须保留", "Positive", text.title)
        val clip = text.inputs["clip"] as List<*>
        assertEquals("链接输入必须转成节点引用", "10", clip[0])
        assertEquals("引用槽位必须保留", 1, (clip[1] as Number).toInt())
        assertEquals("widget 值必须按输入名落位", "hello", text.inputs["text"])

        val sampler = workflow.getValue("30")
        val positive = sampler.inputs["positive"] as List<*>
        assertEquals("Reroute 必须塌缩为原节点引用", "20", positive[0])
        assertEquals("widget 序必须按输入顺序落位", 42, (sampler.inputs["seed"] as Number).toInt())
        assertEquals("后续 widget 不得错位", 20, (sampler.inputs["steps"] as Number).toInt())

        assertEquals("Loader widget 值必须落位", "model.safetensors", workflow.getValue("10").inputs["ckpt_name"])
    }

    @Test
    fun `canvas missing link rejected`() {
        val broken = """
            {"nodes":[{"id":20,"type":"CLIPTextEncode","inputs":[{"name":"clip","link":999}]}],"links":[]}
        """.trimIndent()
        val error = assertThrows(ImageGenConfigException::class.java) {
            ComfyWorkflowCodec.normalizeFromText(broken)
        }
        assertTrue("断链必须报明确错误：${error.message}", error.message!!.contains("连接无效"))
    }

    @Test
    fun `hash is stable short hex and content sensitive`() {
        val a = ComfyWorkflowCodec.normalizeFromText(
            """{"3":{"class_type":"KSampler","inputs":{"seed":1}}}""",
        ).workflow
        val b = ComfyWorkflowCodec.normalizeFromText(
            """{"3":{"class_type":"KSampler","inputs":{"seed":1}}}""",
        ).workflow
        val c = ComfyWorkflowCodec.normalizeFromText(
            """{"3":{"class_type":"KSampler","inputs":{"seed":2}}}""",
        ).workflow
        val hashA = ComfyWorkflowCodec.hashWorkflow(a)
        assertTrue("哈希必须是 16 位十六进制", hashA.matches(Regex("[0-9a-f]{16}")))
        assertEquals("同内容必须得到同哈希", hashA, ComfyWorkflowCodec.hashWorkflow(b))
        assertFalse("内容变化必须改变哈希", hashA == ComfyWorkflowCodec.hashWorkflow(c))
    }

    @Test
    fun `image output whitelist drives hasImageOutput`() {
        assertTrue(
            "SaveImageAdvanced 必须算图片输出",
            ComfyWorkflowCodec.hasImageOutput(
                ComfyWorkflowCodec.normalizeFromText("""{"1":{"class_type":"SaveImageAdvanced","inputs":{}}}""").workflow,
            ),
        )
        assertFalse(
            "纯视频输出不得算图片输出",
            ComfyWorkflowCodec.hasImageOutput(
                ComfyWorkflowCodec.normalizeFromText("""{"1":{"class_type":"SaveVideo","inputs":{}}}""").workflow,
            ),
        )
    }
}
