package com.qingyu.companion.chatcore

import java.util.Locale
import kotlin.random.Random

/**
 * 阶段 4 S4-01：宏系统（对齐 `shared/chat-core/macros.ts`）。
 *
 * 语法 `{{name}}` 或 `{{name:参数}}`；未注册的宏原样保留（避免误删用户内容）。
 * 非确定宏（`random` / `id` / `time` / `date` / `datetime`）通过 [ChatMacros.random] 与
 * [ChatMacros.now] 注入，便于测试固定行为；生产使用默认实现。
 */
/** 宏实现：args 为已按 `|` 拆分并 trim 的参数（无参数时为空列表）。 */
typealias MacroFn = (List<String>, ChatMacros.Context) -> String

object ChatMacros {

    /** 宏上下文（与 TS `MacroContext` 字段一一对应）。 */
    data class Context(
        val userName: String,
        val charName: String,
        val originalCharName: String? = null,
        val groupName: String? = null,
        val lastMessage: String? = null,
        val lastUserMessage: String? = null,
    )

    /** 注册表：name（小写）-> 实现。 */
    private val registry: MutableMap<String, MacroFn> = mutableMapOf()

    /** 宏元数据（补全/提示用），保持注册顺序。 */
    private val meta: MutableMap<String, MacroInfo> = linkedMapOf()

    data class MacroInfo(val name: String, val description: String, val example: String)

    /** 非确定来源：默认系统时钟与随机数；测试可注入固定实现。 */
    var now: () -> java.util.Calendar = { java.util.Calendar.getInstance() }
    var random: Random = Random.Default

    private val MACRO_SYNTAX = Regex("\\{\\{\\s*[a-zA-Z_][a-zA-Z0-9_]*")
    private val MACRO_EXPAND =
        Regex("\\{\\{\\s*([a-zA-Z_][a-zA-Z0-9_]*)(?::([^}]*))?\\s*\\}\\}")

    private fun pad(n: Int): String = if (n < 10) "0$n" else "$n"

    /** 内置宏注册（幂等）。 */
    private fun ensureBuiltIns() {
        if (registry.isNotEmpty()) return
        register("time", { _, _ ->
            val d = now()
            "${pad(d.get(java.util.Calendar.HOUR_OF_DAY))}:${pad(d.get(java.util.Calendar.MINUTE))}"
        }, MacroInfo("time", "当前时间（HH:mm）", "{{time}} → 14:30"))
        register("date", { _, _ ->
            val d = now()
            "${d.get(java.util.Calendar.YEAR)}/${pad(d.get(java.util.Calendar.MONTH) + 1)}/${pad(d.get(java.util.Calendar.DAY_OF_MONTH))}"
        }, MacroInfo("date", "当前日期（YYYY/MM/DD）", "{{date}} → 2026/07/31"))
        register("datetime", { _, _ ->
            val d = now()
            "${d.get(java.util.Calendar.YEAR)}/${pad(d.get(java.util.Calendar.MONTH) + 1)}/${pad(d.get(java.util.Calendar.DAY_OF_MONTH))} " +
                "${pad(d.get(java.util.Calendar.HOUR_OF_DAY))}:${pad(d.get(java.util.Calendar.MINUTE))}"
        }, MacroInfo("datetime", "当前日期时间", "{{datetime}} → 2026/07/31 14:30"))
        register("random", { args, _ ->
            if (args.isEmpty()) "" else args[random.nextInt(args.size)]
        }, MacroInfo("random", "随机取一个选项（| 分隔）", "{{random:早安|晚安}}"))
        register("newline", { _, _ -> "\n" }, MacroInfo("newline", "换行", "{{newline}}"))
        register("group", { _, ctx -> ctx.groupName ?: "" }, MacroInfo("group", "群聊名称（单聊为空）", "{{group}}"))
        register("lastMessage", { _, ctx -> ctx.lastMessage ?: "" }, MacroInfo("lastMessage", "最后一条消息内容", "{{lastMessage}}"))
        register(
            "lastUserMessage",
            { _, ctx -> ctx.lastUserMessage ?: "" },
            MacroInfo("lastUserMessage", "最后一条用户消息内容", "{{lastUserMessage}}"),
        )
        register("char", { _, ctx -> ctx.charName }, MacroInfo("char", "角色名", "{{char}}"))
        register("user", { _, ctx -> ctx.userName }, MacroInfo("user", "用户名", "{{user}}"))
        register(
            "original",
            { _, ctx -> ctx.originalCharName ?: ctx.charName },
            MacroInfo("original", "角色原名", "{{original}}"),
        )
        register(
            "id",
            { _, _ ->
                // TS：Math.random().toString(36).slice(2, 8) -> 6 位 [a-z0-9]
                buildString(6) {
                    repeat(6) { append(ALPHABET36[random.nextInt(ALPHABET36.length)]) }
                }
            },
            MacroInfo("id", "随机短 ID", "{{id}} → a1b2c3"),
        )
    }

    private const val ALPHABET36 = "0123456789abcdefghijklmnopqrstuvwxyz"

    fun register(name: String, fn: MacroFn, info: MacroInfo? = null) {
        registry[name.lowercase(Locale.ROOT)] = fn
        if (info != null) meta[name.lowercase(Locale.ROOT)] = info
    }

    fun unregister(name: String) {
        val key = name.lowercase(Locale.ROOT)
        registry.remove(key)
        meta.remove(key)
    }

    fun listMacros(): List<MacroInfo> {
        ensureBuiltIns()
        return meta.values.toList()
    }

    /** 文本是否包含宏语法。 */
    fun hasMacro(text: String): Boolean {
        ensureBuiltIns()
        return MACRO_SYNTAX.containsMatchIn(text)
    }

    /**
     * 拆分 `{{name:a|b|c}}` 参数：`|` 分隔，`\|` 转义为字面竖线，每段 trim。
     * 空 raw（含 `{{name:}}`）返回空列表。
     */
    fun splitArgs(raw: String?): List<String> {
        if (raw.isNullOrEmpty()) return emptyList()
        val result = mutableListOf<String>()
        val cur = StringBuilder()
        var i = 0
        while (i < raw.length) {
            val ch = raw[i]
            if (ch == '\\' && i + 1 < raw.length && raw[i + 1] == '|') {
                cur.append('|')
                i += 2
                continue
            }
            if (ch == '|') {
                result += cur.toString().trim()
                cur.setLength(0)
            } else {
                cur.append(ch)
            }
            i++
        }
        result += cur.toString().trim()
        return result
    }

    /** 展开文本中的所有宏；未注册的宏原样保留。 */
    fun expandMacros(text: String, ctx: Context): String {
        if (text.isEmpty()) return text
        if (!hasMacro(text)) return text
        return MACRO_EXPAND.replace(text) { match ->
            val name = match.groupValues[1].lowercase(Locale.ROOT)
            val fn = registry[name] ?: return@replace match.value
            val rawArgs = match.groupValues[2].takeIf { it.isNotEmpty() || match.value.contains(':') }
            runCatching { fn(splitArgs(rawArgs), ctx) }.getOrElse { match.value }
        }
    }

    /**
     * 从消息数组构造宏上下文（对齐 TS `buildMacroContext`）：
     * - `lastMessage`：最后一条**非空白**消息内容；
     * - `lastUserMessage`：最后一条**非空白且 role=user** 的消息内容。
     */
    fun buildContext(
        messages: List<MessageLike>?,
        userName: String,
        charName: String,
        originalCharName: String? = null,
        groupName: String? = null,
    ): Context {
        val list = messages ?: emptyList()
        val last = list.lastOrNull { it.content.trim().isNotEmpty() }
        val lastUser = list.lastOrNull { it.role == "user" && it.content.trim().isNotEmpty() }
        return Context(
            userName = userName,
            charName = charName,
            originalCharName = originalCharName,
            groupName = groupName,
            lastMessage = last?.content ?: "",
            lastUserMessage = lastUser?.content ?: "",
        )
    }

    /** 供 [buildContext] 使用的最小消息视图（避免依赖具体 DTO）。 */
    interface MessageLike {
        val role: String
        val content: String
    }
}
