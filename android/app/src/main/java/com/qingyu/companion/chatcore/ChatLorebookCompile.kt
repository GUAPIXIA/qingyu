package com.qingyu.companion.chatcore

/**
 * 阶段 4 A3b-2：canonical v2 世界书文档 → 运行时输入
 * （对齐 `shared/lorebook/runtime/compile.ts` 的 `compileEntry`）。
 *
 * 本地库里的世界书以 **canonical v2 文档**（`local_lorebooks.canonical_json`）存放，
 * 而运行时读的是「已编译」的条目形状。缺了这一步，运行时永远拿到空条目列表——
 * 表现就是「用户绑定了世界书，却一条都不注入」，且不报任何错。
 *
 * 字段映射逐条对齐 PC：
 * - `activation.mode` = constant → **always**；`budgetTier` = supplemental → **detail**；否则 conditional
 * - `keywords` = `primaryKeys + aliases`（别名与主关键词同权参与触发）
 * - `insertion` 直接透传（渲染层据此分桶），并按它回填旧式 `position/depth/role`
 * - `retrieval` **原样带进运行时**（`keyword` / `hybrid` / `semanticPreferred` / `semanticRequired`）。
 *   它当前**不改变触发结果**（运行时只有关键词通道），而是交给 `ChatLorebookChannels`
 *   判定「这条要求的通道本机有没有」——此前这里的注释声称做了一个 `retrieval → matchMode`
 *   的映射，但代码从未读过该字段，属于「注释声称有、代码里没有」。
 */
object ChatLorebookCompile {

    /** canonical v2 文档 → 运行时书。解析失败返回 null（由调用方决定是否视为损坏）。 */
    fun compile(canonicalJson: String, id: String, name: String): ChatLorebookRuntime.Book? {
        val document = runCatching { org.json.JSONObject(canonicalJson) }.getOrNull() ?: return null
        val defaults = document.optJSONObject("defaults")
        val scanDepth = defaults?.optInt("scanDepth")?.takeIf { defaults.has("scanDepth") }
        val recursiveScanning = defaults?.optBoolean("recursiveScanning", true) ?: true
        val tokenBudget = defaults?.optInt("tokenBudget")?.takeIf { defaults.has("tokenBudget") && it > 0 }
        val entriesArray = document.optJSONArray("entries") ?: return ChatLorebookRuntime.Book(
            id = id,
            name = name,
            enabled = true,
            scanDepth = scanDepth,
            recursiveScanning = recursiveScanning,
            tokenBudget = tokenBudget,
        )
        val entries = (0 until entriesArray.length()).mapNotNull { index ->
            entriesArray.optJSONObject(index)?.let { compileEntry(it) }
        }
        return ChatLorebookRuntime.Book(
            id = id,
            name = name,
            enabled = true,
            scanDepth = scanDepth,
            recursiveScanning = recursiveScanning,
            tokenBudget = tokenBudget,
            entries = entries,
        )
    }

    private fun compileEntry(entry: org.json.JSONObject): ChatLorebookRuntime.Entry? {
        val entryId = entry.optString("id")
        if (entryId.isEmpty()) return null
        val activation = entry.optJSONObject("activation")
        val scheduling = entry.optJSONObject("scheduling")
        val insertion = entry.optJSONObject("insertion")

        val mode = activation?.optString("mode") ?: "conditional"
        val budgetTier = activation?.optString("budgetTier") ?: "standard"
        val priority = when {
            mode == "constant" -> "always"
            budgetTier == "supplemental" -> "detail"
            else -> "conditional"
        }

        val primaryKeys = stringList(activation?.optJSONArray("primaryKeys"))
        val aliases = stringList(activation?.optJSONArray("aliases"))
        val secondaryKeys = stringList(activation?.optJSONArray("secondaryKeys"))
        // 缺省与 canonical 模型同口径（`CanonicalLoreEntryActivation.retrieval = "keyword"`）：
        // 取 "both" 之类的旧词会让本机把一条 keyword 条目判成需要语义通道。
        val retrieval = activation?.optString("retrieval")?.takeIf { it.isNotEmpty() } ?: "keyword"
        val regex = activation?.optJSONObject("regex")
        val recursion = scheduling?.optJSONObject("recursion")
        val characterFilter = scheduling?.optJSONObject("characterFilter")
        val generationTriggers = scheduling?.optJSONArray("generationTriggers")?.let { array ->
            (0 until array.length()).map { array.optString(it) }.filter { it.isNotEmpty() }
        }

        val compiledInsertion = compileInsertion(insertion)
        // 旧式 position/depth/role 由 insertion 回填，保持与 PC 的 compileInsertion 一致
        val position = when {
            compiledInsertion is ChatLorebookBudget.Insertion.Chat -> "at_depth"
            compiledInsertion is ChatLorebookBudget.Insertion.Prompt && compiledInsertion.anchor == "before_character" ->
                "before_char"
            compiledInsertion is ChatLorebookBudget.Insertion.Prompt && compiledInsertion.anchor == "after_character" ->
                "after_char"
            else -> "at_end"
        }

        return ChatLorebookRuntime.Entry(
            id = entryId,
            content = entry.optString("content"),
            keywords = primaryKeys + aliases,
            secondaryKeywords = secondaryKeys,
            selectiveLogic = activation?.optString("secondaryLogic")?.takeIf { it.isNotEmpty() },
            useRegex = regex?.optBoolean("enabled") ?: false,
            regexFlags = regex?.optString("flags")?.takeIf { it.isNotEmpty() },
            caseSensitive = activation?.optBoolean("caseSensitive") ?: false,
            matchWholeWords = activation?.optBoolean("wholeWords") ?: true,
            enabled = entry.optBoolean("enabled", true),
            position = position,
            depth = (compiledInsertion as? ChatLorebookBudget.Insertion.Chat)?.depth,
            role = (compiledInsertion as? ChatLorebookBudget.Insertion.Chat)?.role,
            priority = priority,
            order = scheduling?.optInt("order") ?: 0,
            summary = entry.optString("summary").takeIf { it.isNotEmpty() },
            ignoreBudget = scheduling?.optBoolean("ignoreBudget") ?: false,
            probability = if (scheduling?.has("probability") == true) scheduling.optDouble("probability") else null,
            preventRecursion = recursion?.optBoolean("prevent") ?: false,
            excludeRecursion = recursion?.optBoolean("exclude") ?: false,
            scanDepth = if (scheduling?.has("scanDepth") == true) scheduling.optInt("scanDepth") else null,
            generationTriggers = generationTriggers,
            characterFilter = characterFilter?.let {
                ChatLorebookRuntime.CharacterFilter(
                    names = stringList(it.optJSONArray("names")),
                    tags = stringList(it.optJSONArray("tags")),
                    exclude = it.optBoolean("exclude") ?: false,
                )
            },
            insertion = compiledInsertion,
            retrieval = retrieval,
        )
    }

    /**
     * canonical `insertion` → 预算层插入位置。
     *
     * outlet / custom 没有原生槽位，按 PC 的回退语义落到 `prompt_end`
     * （渲染层同样会这样回退，这里保持一致即可，避免两处各写一套）。
     */
    private fun compileInsertion(insertion: org.json.JSONObject?): ChatLorebookBudget.Insertion {
        if (insertion == null) return ChatLorebookBudget.Insertion.Prompt("prompt_end")
        return when (insertion.optString("kind")) {
            "prompt" -> ChatLorebookBudget.Insertion.Prompt(
                insertion.optString("anchor").takeIf { it.isNotEmpty() } ?: "prompt_end",
            )
            "chat" -> ChatLorebookBudget.Insertion.Chat(
                depth = maxOf(0, insertion.optInt("depth")),
                role = insertion.optString("role").takeIf { it.isNotEmpty() },
            )
            else -> ChatLorebookBudget.Insertion.Prompt("prompt_end")
        }
    }

    private fun stringList(array: org.json.JSONArray?): List<String> {
        if (array == null) return emptyList()
        return (0 until array.length()).map { array.optString(it) }.filter { it.isNotEmpty() }
    }
}
