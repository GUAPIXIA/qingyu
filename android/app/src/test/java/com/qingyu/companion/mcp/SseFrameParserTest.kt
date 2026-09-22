package com.qingyu.companion.mcp

import com.qingyu.companion.mcp.transport.SseFrameParser
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * SSE 分帧解析测试（S6-06：SSE 传输的分帧解析必须纯 JVM 可测）。
 */
class SseFrameParserTest {

    @Test
    fun `单个事件按空行派发`() {
        val parser = SseFrameParser()
        val events = parser.feed("data: hello\n\n")
        assertEquals(1, events.size, "一个空行分隔块应产出一个事件")
        assertEquals("hello", events[0].data, "data 字段应成为事件数据")
        assertEquals("message", events[0].event, "未写 event 字段时默认 message")
    }

    @Test
    fun `跨块分帧重组同一个事件`() {
        val parser = SseFrameParser()
        assertTrue(parser.feed("data: par").isEmpty(), "事件未以空行终结前不得产出半个事件")
        assertTrue(parser.feed("t1\ndata: part").isEmpty(), "多行 data 未终结前不得产出")
        val events = parser.feed("2\n\n")
        assertEquals(1, events.size, "分块落在任意位置都应重组成完整事件")
        assertEquals("part1\npart2", events[0].data, "多行 data 应按换行合并")
    }

    @Test
    fun `CRLF 与 CR 换行都按行解析`() {
        val parser = SseFrameParser()
        val crlf = parser.feed("event: delta\r\ndata: x\r\n\r\n")
        assertEquals(1, crlf.size, "CRLF 换行的事件应正常产出")
        assertEquals("delta", crlf[0].event, "event 字段应被解析")
        val parser2 = SseFrameParser()
        val cr = parser2.feed("data: y\r\r")
        assertEquals(1, cr.size, "CR 换行的事件应正常产出")
        assertEquals("y", cr[0].data, "CR 换行不应污染数据内容")
    }

    @Test
    fun `注释行与未知字段被忽略`() {
        val parser = SseFrameParser()
        val events = parser.feed(": keep-alive\nunknown: 1\ndata: real\n\n")
        assertEquals(1, events.size, "注释与未知字段不得产生额外事件")
        assertEquals("real", events[0].data, "注释不得混入事件数据")
    }

    @Test
    fun `多个事件按顺序产出且 id 与 retry 生效`() {
        val parser = SseFrameParser()
        val events = parser.feed("id: 7\nretry: 1500\ndata: first\n\nevent: note\ndata: second\n\n")
        assertEquals(2, events.size, "两个空行分隔块应产出两个事件")
        assertEquals("first", events[0].data, "第一个事件数据错误")
        assertEquals("7", events[0].id, "id 字段应随事件携带")
        assertEquals(1500L, events[0].retry, "retry 字段应随事件携带")
        assertEquals("note", events[1].event, "第二个事件的 event 字段错误")
    }

    @Test
    fun `未以空行终结的残余事件在流结束时丢弃`() {
        val parser = SseFrameParser()
        assertTrue(parser.feed("data: dangling").isEmpty(), "未终结事件不得提前产出")
        assertTrue(parser.finish().isEmpty(), "流结束时残余事件按规范丢弃，不得补发")
    }

    @Test
    fun `只有 event 名没有 data 的块不派发`() {
        val parser = SseFrameParser()
        val events = parser.feed("event: ping\n\ndata: real\n\n")
        assertEquals(1, events.size, "无 data 的事件块不得派发")
        assertEquals("real", events[0].data, "无 data 块不得吞掉后续真实事件")
    }
}
