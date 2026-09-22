package com.qingyu.companion.imagegen

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * S6-04：ComfyUI 工作流纯分析逻辑与 PC `comfyWorkflow.ts` 对齐
 * （shared/fixtures 无 ComfyUI fixture，按任务约定实现等价纯逻辑并配 JVM 测试）。
 */
class ComfyWorkflowAnalyzerTest {

    /** 标准文生图：Checkpoint → CLIP 编码正/负 → KSampler → VAEDecode → SaveImage。 */
    private val txt2imgJson = """
        {
          "3": {"class_type":"KSampler","inputs":{"seed":42,"steps":20,"cfg":7,"sampler_name":"euler","scheduler":"normal","denoise":1,"model":["4",0],"positive":["6",0],"negative":["7",0],"latent_image":["5",0]}},
          "4": {"class_type":"CheckpointLoaderSimple","inputs":{"ckpt_name":"sd.safetensors"}},
          "5": {"class_type":"EmptyLatentImage","inputs":{"width":512,"height":768}},
          "6": {"class_type":"CLIPTextEncode","inputs":{"text":"a cat","clip":["4",1]}},
          "7": {"class_type":"CLIPTextEncode","inputs":{"text":"blurry","clip":["4",1]}},
          "8": {"class_type":"VAEDecode","inputs":{"samples":["3",0],"vae":["4",2]}},
          "9": {"class_type":"SaveImage","inputs":{"images":["8",0],"filename_prefix":"ComfyUI"}}
        }
    """.trimIndent()

    private fun analyze(json: String, objectInfo: Map<String, Any?>? = null): ComfyWorkflowAnalysis =
        ComfyWorkflowAnalyzer.analyze(ComfyWorkflowCodec.normalizeFromText(json).workflow, objectInfo)

    @Test
    fun `text to image workflow analyzed with bindings parameters and dependencies`() {
        val analysis = analyze(txt2imgJson)
        assertEquals("文生图工作流必须识别为 text-to-image", ComfyWorkflowKind.TextToImage, analysis.kind)
        assertEquals("节点数必须统计全部节点", 7, analysis.nodeCount)
        assertTrue("标准文生图必须判定可用", analysis.compatible)

        val positive = analysis.promptBindings.filter { it.role == ComfyBindingRole.Positive }
        val negative = analysis.promptBindings.filter { it.role == ComfyBindingRole.Negative }
        assertEquals("正面提示词入口必须唯一", 1, positive.size)
        assertEquals("正面提示词入口必须是 6.text", "6", positive[0].nodeId)
        assertEquals("绑定必须保留工作流原值", "a cat", positive[0].workflowValue)
        assertEquals("负面提示词入口必须唯一", 1, negative.size)
        assertEquals("负面提示词入口必须是 7.text", "7", negative[0].nodeId)

        assertEquals("输出绑定必须指向 SaveImage", "9", analysis.outputBindings.single().nodeId)
        assertEquals("输出绑定输入名固定 images", "images", analysis.outputBindings.single().inputName)

        val sizeGroup = analysis.parameterGroups.single { it.stage == ComfyParameterStage.Output }
        val sizeParam = sizeGroup.parameters.single()
        assertEquals("尺寸参数 id 即覆盖键", "5.width", sizeParam.id)
        assertEquals("尺寸必须拼成 WxH", "512x768", sizeParam.workflowValue)
        assertEquals("size 参数必须携带配对 height 输入", "height", sizeParam.pairedInputName)

        val samplerGroup = analysis.parameterGroups.single { it.stage == ComfyParameterStage.Sampling }
        val byInput = samplerGroup.parameters.associateBy { it.inputName }
        assertEquals("采样器必须暴露 steps", ComfyParameterType.Number, byInput["steps"]?.type)
        assertEquals("采样器必须暴露 cfg", ComfyParameterType.Number, byInput["cfg"]?.type)
        assertEquals("采样器必须暴露 sampler_name", ComfyParameterType.Select, byInput["sampler_name"]?.type)
        assertEquals("种子归入高级区", true, byInput["seed"]?.advanced)

        val dependency = analysis.dependencies.single()
        assertEquals("模型依赖必须指向 Checkpoint 输入", "ckpt_name", dependency.inputName)
        assertEquals("模型文件名必须保留", "sd.safetensors", dependency.value)
        assertEquals("Loader 能力必须列全", listOf("MODEL", "CLIP", "VAE"), dependency.provides)
        assertEquals("引用方必须覆盖四个下游节点", 4, dependency.usedBy.size)

        assertTrue("标准工作流不应有警告", analysis.warnings.isEmpty())
    }

    @Test
    fun `conditioning zero-out barrier prevents positive text misclassified as negative`() {
        val json = """
            {
              "3": {"class_type":"KSampler","inputs":{"seed":1,"steps":10,"cfg":7,"model":["4",0],"positive":["6",0],"negative":["20",0],"latent_image":["5",0]}},
              "4": {"class_type":"CheckpointLoaderSimple","inputs":{"ckpt_name":"m.safetensors"}},
              "5": {"class_type":"EmptyLatentImage","inputs":{"width":512,"height":512}},
              "6": {"class_type":"CLIPTextEncode","inputs":{"text":"a cat","clip":["4",1]}},
              "20": {"class_type":"ConditioningZeroOut","inputs":{"conditioning":["6",0]}},
              "8": {"class_type":"VAEDecode","inputs":{"samples":["3",0],"vae":["4",2]}},
              "9": {"class_type":"SaveImage","inputs":{"images":["8",0]}}
            }
        """.trimIndent()
        val analysis = analyze(json)
        val negative = analysis.promptBindings.filter { it.role == ComfyBindingRole.Negative }
        assertTrue("屏障节点后的正面文本不得被误判为负面入口", negative.isEmpty())
        val positive = analysis.promptBindings.filter { it.role == ComfyBindingRole.Positive }
        assertEquals("正面文本必须保持正面绑定", "6", positive.single().nodeId)
    }

    @Test
    fun `warnings cover ambiguity multi-stage and unreachable nodes`() {
        val json = """
            {
              "3": {"class_type":"KSampler","inputs":{"seed":1,"steps":10,"cfg":7,"model":["4",0],"positive":["6",0],"negative":["7",0],"latent_image":["5",0]}},
              "13": {"class_type":"KSampler","inputs":{"seed":2,"steps":10,"cfg":7,"model":["4",0],"positive":["6",0],"negative":["7",0],"latent_image":["3",0]}},
              "4": {"class_type":"CheckpointLoaderSimple","inputs":{"ckpt_name":"m.safetensors"}},
              "5": {"class_type":"EmptyLatentImage","inputs":{"width":512,"height":512}},
              "6": {"class_type":"CLIPTextEncode","inputs":{"text":"a cat","clip":["4",1]}},
              "7": {"class_type":"CLIPTextEncode","inputs":{"text":"blurry","clip":["4",1]}},
              "66": {"class_type":"CLIPTextEncode","inputs":{"text":"extra positive","clip":["4",1]}},
              "8": {"class_type":"VAEDecode","inputs":{"samples":["13",0],"vae":["4",2]}},
              "9": {"class_type":"SaveImage","inputs":{"images":["8",0]}}
            }
        """.trimIndent()
        val analysis = analyze(json)
        val codes = analysis.warnings.map { it.code }.toSet()
        assertTrue("断开的 66 节点必须报告并被忽略", ComfyWorkflowWarningCode.UnreachableNodes in codes)
        assertTrue("多采样阶段必须报告", ComfyWorkflowWarningCode.MultiStage in codes)
        assertEquals(
            "未连接节点必须列出 id",
            listOf("66"),
            analysis.warnings.single { it.code == ComfyWorkflowWarningCode.UnreachableNodes }.nodeIds,
        )
        assertTrue("断开节点不得进入提示词绑定", analysis.promptBindings.none { it.nodeId == "66" })
    }

    @Test
    fun `ambiguous positive prompt reported`() {
        val json = """
            {
              "3": {"class_type":"KSampler","inputs":{"seed":1,"steps":10,"cfg":7,"model":["4",0],"positive":["30",0],"latent_image":["5",0]}},
              "4": {"class_type":"CheckpointLoaderSimple","inputs":{"ckpt_name":"m.safetensors"}},
              "5": {"class_type":"EmptyLatentImage","inputs":{"width":512,"height":512}},
              "6": {"class_type":"CLIPTextEncode","inputs":{"text":"a cat","clip":["4",1]}},
              "21": {"class_type":"CLIPTextEncode","inputs":{"text":"also positive","clip":["4",1]}},
              "30": {"class_type":"ConditioningCombine","inputs":{"conditioning_1":["6",0],"conditioning_2":["21",0]}},
              "8": {"class_type":"VAEDecode","inputs":{"samples":["3",0],"vae":["4",2]}},
              "9": {"class_type":"SaveImage","inputs":{"images":["8",0]}}
            }
        """.trimIndent()
        val analysis = analyze(json)
        assertTrue(
            "多个正面候选必须以 ambiguous-prompt 提示用户确认",
            analysis.warnings.any { it.code == ComfyWorkflowWarningCode.AmbiguousPrompt },
        )
    }

    @Test
    fun `image-to-image and video workflows flagged`() {
        val img2img = """
            {
              "3": {"class_type":"KSampler","inputs":{"seed":1,"steps":10,"cfg":7,"model":["4",0],"positive":["6",0],"latent_image":["21",0]}},
              "4": {"class_type":"CheckpointLoaderSimple","inputs":{"ckpt_name":"m.safetensors"}},
              "21": {"class_type":"LoadImage","inputs":{"image":"in.png"}},
              "6": {"class_type":"CLIPTextEncode","inputs":{"text":"a cat","clip":["4",1]}},
              "8": {"class_type":"VAEDecode","inputs":{"samples":["3",0],"vae":["4",2]}},
              "9": {"class_type":"SaveImage","inputs":{"images":["8",0]}}
            }
        """.trimIndent()
        val img2imgAnalysis = analyze(img2img)
        assertEquals("带 LoadImage 的工作流必须识别为图生图", ComfyWorkflowKind.ImageToImage, img2imgAnalysis.kind)
        assertTrue(
            "图生图必须提示需要输入图片",
            img2imgAnalysis.warnings.any { it.code == ComfyWorkflowWarningCode.RequiresImageInput },
        )
        assertEquals("图生图不得判定为可直接保存", false, img2imgAnalysis.compatible)

        val video = """
            {
              "3": {"class_type":"KSampler","inputs":{"seed":1,"steps":10,"cfg":7,"model":["4",0],"positive":["6",0],"latent_image":["5",0]}},
              "4": {"class_type":"CheckpointLoaderSimple","inputs":{"ckpt_name":"m.safetensors"}},
              "5": {"class_type":"EmptyLatentImage","inputs":{"width":512,"height":512}},
              "6": {"class_type":"CLIPTextEncode","inputs":{"text":"a cat","clip":["4",1]}},
              "8": {"class_type":"VAEDecode","inputs":{"samples":["3",0],"vae":["4",2]}},
              "9": {"class_type":"VHS_VideoCombine","inputs":{"images":["8",0]}}
            }
        """.trimIndent()
        val videoAnalysis = analyze(video)
        assertEquals("视频输出必须识别为 video", ComfyWorkflowKind.Video, videoAnalysis.kind)
        assertTrue(
            "视频工作流必须提示不能作为图片模型",
            videoAnalysis.warnings.any { it.code == ComfyWorkflowWarningCode.VideoWorkflow },
        )
    }

    @Test
    fun `missing output and missing prompt reported`() {
        val noOutput = """
            {
              "3": {"class_type":"KSampler","inputs":{"seed":1,"steps":10,"cfg":7,"model":["4",0],"positive":["6",0],"latent_image":["5",0]}},
              "4": {"class_type":"CheckpointLoaderSimple","inputs":{"ckpt_name":"m.safetensors"}},
              "5": {"class_type":"EmptyLatentImage","inputs":{"width":512,"height":512}},
              "6": {"class_type":"CLIPTextEncode","inputs":{"text":"a cat","clip":["4",1]}}
            }
        """.trimIndent()
        val analysis = analyze(noOutput)
        assertTrue(
            "没有图片输出节点必须报告",
            analysis.warnings.any { it.code == ComfyWorkflowWarningCode.NoOutput },
        )
        assertEquals("没有输出不得判定可用", false, analysis.compatible)

        val noPrompt = """
            {
              "5": {"class_type":"EmptyLatentImage","inputs":{"width":512,"height":512}},
              "9": {"class_type":"SaveImage","inputs":{"images":["18",0]}},
              "18": {"class_type":"EmptyLatentImage","inputs":{"width":64,"height":64}}
            }
        """.trimIndent()
        val promptless = analyze(noPrompt)
        assertTrue(
            "没有正面提示词入口必须报告",
            promptless.warnings.any { it.code == ComfyWorkflowWarningCode.NoPrompt },
        )
    }

    @Test
    fun `object info validates node types and model availability`() {
        val objectInfo = mapOf<String, Any?>(
            "KSampler" to mapOf<String, Any?>("input" to emptyMap<String, Any?>()),
            "CheckpointLoaderSimple" to mapOf<String, Any?>(
                "input" to mapOf<String, Any?>(
                    "ckpt_name" to listOf<Any?>(
                        listOf("other.safetensors"),
                        emptyMap<String, Any?>(),
                    ),
                ),
            ),
            "EmptyLatentImage" to mapOf<String, Any?>("input" to emptyMap<String, Any?>()),
            "CLIPTextEncode" to mapOf<String, Any?>("input" to emptyMap<String, Any?>()),
            "VAEDecode" to mapOf<String, Any?>("input" to emptyMap<String, Any?>()),
        )
        val analysis = analyze(txt2imgJson, objectInfo)
        assertTrue(
            "模型不在可用列表必须报告 missing-model",
            analysis.warnings.any { it.code == ComfyWorkflowWarningCode.MissingModel },
        )
        assertEquals("依赖必须标记模型不可用", false, analysis.dependencies.single().available)
        assertTrue(
            "SaveImage 不在 object_info 时必须报告 unknown-node",
            analysis.warnings.any {
                it.code == ComfyWorkflowWarningCode.UnknownNode && it.nodeIds == listOf("9")
            },
        )
    }

    @Test
    fun `infer settings fills wizard defaults`() {
        val settings = ComfyWorkflowAnalyzer.inferSettings(ComfyWorkflowCodec.normalizeFromText(txt2imgJson).workflow)
        assertEquals("尺寸取 EmptyLatentImage", "512x768", settings.size)
        assertEquals("步数取 KSampler", 20L, settings.steps)
        assertEquals("CFG 取 KSampler", 7.0, settings.cfgScale!!, 0.0)
        assertEquals("采样器取 KSampler", "euler", settings.sampler)
        assertEquals("调度器取 KSampler", "normal", settings.scheduler)
        assertEquals("模型取 Checkpoint", "sd.safetensors", settings.model)
        assertEquals("负面提示词取 negative 链上的文本节点", "blurry", settings.negativePrompt)
    }
}
