package com.qingyu.companion.content.backup

import com.qingyu.companion.local.db.LocalUsageClearMarkerEntity
import com.qingyu.companion.local.testing.FakeLocalStore
import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 阶段 5 S5-08：Backup V3 的 **create → inspect → restore 往返**。
 *
 * 这条链路此前只有「路径穿越/密钥排除」的安全测试，没有任何端到端往返用例，
 * 于是「打包器写了什么、恢复器读什么」两边各说各话也不会被发现。
 * 本用例专门盯 `usage_clear_marker`（B-3）：它是同步实体，丢了会让已清理的
 * 用量记录在下一轮同步里复活。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class BackupOrchestratorRoundTripTest {

    private fun mediaRoot(label: String): File =
        File(System.getProperty("java.io.tmpdir"), "qingyu-backup-$label-${System.nanoTime()}")
            .apply { mkdirs() }

    @Test
    fun clearMarkerTravelsToAnotherDeviceThroughBackupAndRestore() = runBlocking {
        val source = FakeLocalStore("pc-device")
        // 走真实写入路径：本机游标只能由 clearUsage 产生（那条路径带因果判定）
        source.clearUsage(mapOf("pc-device" to "12"))
        assertNotNull(source.usageClearMarker("pc-device"), "clearUsage 应留下本机游标")

        val bundle = BackupOrchestrator(source, mediaRoot("src"), "0.3.0").create()

        val target = FakeLocalStore("android-device")
        val outcome = BackupOrchestrator(target, mediaRoot("dst"), "0.3.0").restore(bundle.bytes)

        assertTrue(outcome.ok, "恢复应当成功：${outcome.error}")
        assertEquals(
            1,
            outcome.applied["usageClearMarkers"],
            "另一台设备的清理游标必须被恢复（丢了会在下一轮同步复活已清理记录）",
        )
        val restored = target.usageClearMarker("pc-device")
        assertNotNull(restored, "恢复端要能读到来源设备的游标行")
        assertTrue(
            restored!!.clearedThroughJson.contains("pc-device") && restored.clearedThroughJson.contains("12"),
            "clearedThrough 必须原样带过来，实际 ${restored.clearedThroughJson}",
        )
        // 恢复端自己的游标不能被备份伪造推进：本机那一行只能由 clearUsage 维护
        assertNull(target.usageClearMarker("android-device"))
        assertEquals(1, target.listUsageClearMarkers().size)
    }

    @Test
    fun restoringOnTheSameDeviceSkipsItsOwnMarkerInsteadOfFailing() = runBlocking {
        val source = FakeLocalStore("same-device")
        source.clearUsage(mapOf("same-device" to "7"))
        val bundle = BackupOrchestrator(source, mediaRoot("same-src"), "0.3.0").create()

        val target = FakeLocalStore("same-device")
        val outcome = BackupOrchestrator(target, mediaRoot("same-dst"), "0.3.0").restore(bundle.bytes)

        assertTrue(outcome.ok, "同机恢复不该因为自己的游标行而整体失败：${outcome.error}")
        assertEquals(
            0,
            outcome.applied["usageClearMarkers"],
            "自己的游标不来自备份，计数不得虚增",
        )
        assertEquals(0, target.listUsageClearMarkers().size, "恢复不得伪造本机清理进度")
    }

    @Test
    fun storeRefusesAForgedLocalClearMarkerFromAFile() = runBlocking {
        val store = FakeLocalStore("android-device")
        val thrown = assertFailsWith<IllegalArgumentException> {
            store.putUsageClearMarker(
                LocalUsageClearMarkerEntity(
                    deviceId = "android-device",
                    clearedThroughJson = """{"android-device":"999"}""",
                    tombstonedIdsJson = "[]",
                    updatedAt = 1L,
                ),
            )
        }
        assertTrue(
            thrown.message!!.contains("因果"),
            "错误必须说明为什么拒绝，实际：${thrown.message}",
        )
    }
}
