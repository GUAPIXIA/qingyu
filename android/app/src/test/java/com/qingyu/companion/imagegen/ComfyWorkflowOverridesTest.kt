package com.qingyu.companion.imagegen

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.assertThrows
import org.junit.Test

/**
 * S6-04：工作流参数覆盖边界（PC `applyWorkflowOverrides` + `customComfyWorkflow` 等价语义）。
 */
class ComfyWorkflowOverridesTest {

    /** 两阶段工作流：`57:3` 基础采样 → `88` 精修采样（含冒号节点 ID）。 */
    private val twoStageJson = """
        {
          "57:3": {"class_type":"KSampler","inputs":{"seed":1,"steps":20,"cfg":7,"model":["4",0],"positive":["6",0],"negative":["7",0],"latent_image":["5",0]}},
          "88": {"class_type":"KSampler","inputs":{"seed":9,"steps":10,"cfg":5,"model":["4",0],"positive":["6",0],"negative":["7",0],"latent_image":["57:3",0]}},
          "4": {"class_type":"CheckpointLoaderSimple","inputs":{"ckpt_name":"m.safetensors"}},
          "5": {"class_type":"EmptyLatentImage","inputs":{"width":512,"height":512}},
          "6": {"class_type":"CLIPTextEncode","inputs":{"text":"old positive","clip":["4",1]}},
          "7": {"class_type":"CLIPTextEncode","inputs":{"text":"old negative","clip":["4",1]}},
          "8": {"class_type":"VAEDecode","inputs":{"samples":["88",0],"vae":["4",2]}},
          "9": {"class_type":"SaveImage","inputs":{"images":["8",0]}}
        }
    """.trimIndent()

    private fun build(
        workflowJson: String = twoStageJson,
        prompt: String = "cat",
        negativePrompt: String? = null,
        bindings: ComfyWorkflowBindings? = null,
        overrides: Map<String, Any?>? = null,
        seed: Long = 42,
        width: Int = 512,
        height: Int = 512,
    ): ComfyWorkflow = ComfyWorkflowOverrides.buildRunnableWorkflow(
        workflowJson = workflowJson,
        prompt = prompt,
        negativePrompt = negativePrompt,
        bindings = bindings,
        overrides = overrides,
        width = width,
        height = height,
        seed = seed,
    )

    @Test
    fun `override key with colon node id writes only its own input`() {
        val workflow = build(overrides = linkedMapOf("57:3.steps" to 30))
        assertEquals("冒号节点 ID 必须按最后一个点切分后写入", 30, workflow.getValue("57:3").inputs["steps"])
        val other = workflow.getValue("88").inputs["steps"]
        assertEquals("其它采样阶段不得被覆盖", 10, (other as Number).toInt())
    }

    @Test
    fun `unknown node and dotless override keys ignored silently`() {
        val workflow = build(overrides = linkedMapOf("99:9.steps" to 1, "steps" to 1, ".steps" to 1))
        val steps = workflow.getValue("57:3").inputs["steps"]
        assertEquals("未知节点与非法键必须忽略", 20, (steps as Number).toInt())
    }

    @Test
    fun `explicit seed override beats randomization`() {
        val randomized = build(seed = 42)
        assertEquals("第一个采样阶段必须被随机化", 42L, randomized.getValue("57:3").inputs["seed"])
        val overridden = build(seed = 42, overrides = linkedMapOf("57:3.seed" to 7L))
        assertEquals("用户显式覆盖优先级高于随机化", 7L, overridden.getValue("57:3").inputs["seed"])
    }

    @Test
    fun `only first sampling stage randomized in multi-stage workflow`() {
        val workflow = build(seed = 42)
        assertEquals("入口阶段种子必须被随机化", 42L, workflow.getValue("57:3").inputs["seed"])
        val follow = workflow.getValue("88").inputs["seed"] as Number
        assertEquals("后续阶段必须继承前一阶段种子，不得重新随机", 9, follow.toInt())
    }

    @Test
    fun `all samplers randomized when no entry stage found`() {
        val videoJson = """
            {
              "3": {"class_type":"KSampler","inputs":{"seed":1,"steps":10,"cfg":7,"positive":["6",0],"latent_image":["5",0]}},
              "13": {"class_type":"KSampler","inputs":{"seed":2,"steps":10,"cfg":7,"positive":["6",0],"latent_image":["3",0]}},
              "5": {"class_type":"EmptyLatentImage","inputs":{"width":512,"height":512}},
              "6": {"class_type":"CLIPTextEncode","inputs":{"text":"a cat"}},
              "9": {"class_type":"VHS_VideoCombine","inputs":{"images":["13",0]}}
            }
        """.trimIndent()
        val workflow = build(
            workflowJson = videoJson,
            bindings = ComfyWorkflowBindings(
                positivePromptTargets = listOf(ComfyPromptTarget("6", "text")),
                outputNodeIds = emptyList(),
            ),
            seed = 42,
        )
        assertEquals("找不到入口采样器时全部阶段都要随机化", 42L, workflow.getValue("3").inputs["seed"])
        assertEquals("找不到入口采样器时全部阶段都要随机化", 42L, workflow.getValue("13").inputs["seed"])
    }

    @Test
    fun `legacy prompt node ids map to text input`() {
        val workflow = build(
            bindings = ComfyWorkflowBindings(
                positivePromptNodeIds = listOf("6"),
                negativePromptNodeIds = listOf("7"),
                outputNodeIds = emptyList(),
            ),
            prompt = "new positive",
            negativePrompt = "new negative",
        )
        assertEquals("旧配置的节点 ID 必须映射到 text 输入", "new positive", workflow.getValue("6").inputs["text"])
        assertEquals("旧配置的负面节点必须写入", "new negative", workflow.getValue("7").inputs["text"])
    }

    @Test
    fun `configured targets win over inferred analysis`() {
        val workflow = build(
            bindings = ComfyWorkflowBindings(
                positivePromptTargets = listOf(ComfyPromptTarget("7", "text")),
                outputNodeIds = emptyList(),
            ),
            prompt = "chosen",
        )
        assertEquals("用户绑定的入口必须被写入", "chosen", workflow.getValue("7").inputs["text"])
        assertEquals("推断出的其它入口不得被改写", "old positive", workflow.getValue("6").inputs["text"])
    }

    @Test
    fun `invalid binding target rejected with pc message`() {
        val error = assertThrows(ImageGenConfigException::class.java) {
            build(
                bindings = ComfyWorkflowBindings(
                    positivePromptTargets = listOf(ComfyPromptTarget("99", "text")),
                    outputNodeIds = emptyList(),
                ),
            )
        }
        assertTrue("入口失效必须报重新选择提示：${error.message}", error.message!!.contains("已失效，请重新选择工作流入口"))
    }

    @Test
    fun `workflow without positive entry rejected with pc message`() {
        val promptless = """
            {
              "3": {"class_type":"KSampler","inputs":{"seed":1,"steps":10,"cfg":7,"latent_image":["5",0]}},
              "5": {"class_type":"EmptyLatentImage","inputs":{"width":512,"height":512}},
              "9": {"class_type":"SaveImage","inputs":{"images":["3",0]}}
            }
        """.trimIndent()
        val error = assertThrows(ImageGenConfigException::class.java) { build(workflowJson = promptless) }
        assertTrue(
            "缺正面入口必须报 PC 同文案：${error.message}",
            error.message == "ComfyUI 未选择正面提示词入口，请在生图配置中确认",
        )
    }

    @Test
    fun `negative prompt modes resolved like pc`() {
        assertEquals("请求级负面提示词优先", "req", ComfyWorkflowOverrides.resolveNegativePrompt(ComfyNegativePromptMode.Empty, "preset", "req"))
        assertEquals("preset 模式写预设", "preset", ComfyWorkflowOverrides.resolveNegativePrompt(ComfyNegativePromptMode.Preset, "preset", null))
        assertEquals("preset 模式缺预设时写空串", "", ComfyWorkflowOverrides.resolveNegativePrompt(ComfyNegativePromptMode.Preset, null, null))
        assertEquals("empty 模式显式清空", "", ComfyWorkflowOverrides.resolveNegativePrompt(ComfyNegativePromptMode.Empty, "ignored", null))
        assertEquals("workflow 模式保留工作流原值", null, ComfyWorkflowOverrides.resolveNegativePrompt(ComfyNegativePromptMode.Workflow, "p", null))
        assertEquals("未配置模式等价 workflow", null, ComfyWorkflowOverrides.resolveNegativePrompt(null, "p", null))
    }

    @Test
    fun `negative prompt written or preserved`() {
        val preserved = build()
        assertEquals("未指定负面提示词时保留工作流原值", "old negative", preserved.getValue("7").inputs["text"])
        val cleared = build(negativePrompt = "")
        assertEquals("显式清空必须写空串", "", cleared.getValue("7").inputs["text"])
    }

    @Test
    fun `placeholders replaced including exact match to number`() {
        val json = """
            {
              "6": {"class_type":"CLIPTextEncode","inputs":{"text":"old"}},
              "99": {"class_type":"MyNote","inputs":{"note":"{{prompt}} @ {{width}}x{{height}} #{{seed}}","size_hint":"{{width}}"}},
              "9": {"class_type":"SaveImage","inputs":{"images":["99",0],"meta":["99",0]}}
            }
        """.trimIndent()
        val workflow = build(
            workflowJson = json,
            prompt = "cat",
            bindings = ComfyWorkflowBindings(
                positivePromptTargets = listOf(ComfyPromptTarget("6", "text")),
                outputNodeIds = emptyList(),
            ),
            width = 640,
            height = 360,
        )
        assertEquals(
            "子串占位符必须逐个替换",
            "cat @ 640x360 #42",
            workflow.getValue("99").inputs["note"],
        )
        assertEquals("整串占位符必须替换为对应值（含数字类型）", 640, workflow.getValue("99").inputs["size_hint"])
    }

    @Test
    fun `blank workflow config rejected with pc message`() {
        val error = assertThrows(ImageGenConfigException::class.java) { build(workflowJson = "  ") }
        assertTrue("未配置工作流必须报配置缺失：${error.message}", error.message!!.contains("ComfyUI 未配置工作流"))
    }

    @Test
    fun `runtime workflow does not mutate saved config snapshot`() {
        val first = build(prompt = "first")
        assertEquals("首次构建必须写入提示词", "first", first.getValue("6").inputs["text"])
        val second = build(prompt = "second")
        assertEquals("二次构建必须基于原始快照", "second", second.getValue("6").inputs["text"])
        assertEquals("未覆盖的采样参数不得漂移", 20, (second.getValue("57:3").inputs["steps"] as Number).toInt())
    }
}
