package com.qingyu.companion.ui.content

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.Divider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.qingyu.companion.ui.components.AppTopBar

/**
 * 阶段 5：内容管理入口页。
 *
 * 用一个中心页而不是把六个编辑器分散进设置页的各个角落：
 * - 它们是同一件事（维护聊天资产），分散后用户要记六个不同位置；
 * - 阶段 5 的完成口径是「能力矩阵逐项验收」，集中入口也让每一能力是否可用一眼可见；
 * - 未就绪的能力在这里显示禁用原因，比在设置页里出现一个会崩的入口要好。
 */
@Composable
fun ContentHubScreen(
    onBack: () -> Unit,
    onOpenCharacters: () -> Unit,
    onOpenRegex: () -> Unit,
    onOpenLorebooks: (() -> Unit)? = null,
    onOpenPresets: (() -> Unit)? = null,
    onOpenPersonas: (() -> Unit)? = null,
    onOpenQuickReplies: (() -> Unit)? = null,
    onOpenUsageInsights: (() -> Unit)? = null,
    onOpenBackup: (() -> Unit)? = null,
) {
    Scaffold(
        topBar = {
            AppTopBar(
                title = "内容管理",
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .padding(padding)
                .fillMaxSize()
                .verticalScroll(rememberScrollState()),
        ) {
            Text(
                "这些资产都存在本机，断网、PC 关机时同样可以创建和编辑。",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
            )
            HubRow("角色", "创建、编辑、导入 Character Card（PNG / JSON）、导出", onClick = onOpenCharacters)
            HubRow("正则规则", "输入/输出替换规则与测试台", onClick = onOpenRegex)
            HubRow(
                title = "世界书",
                subtitle = "canonical v2 条目编辑与多格式导入导出",
                onClick = onOpenLorebooks,
            )
            HubRow(
                title = "预设",
                subtitle = "内建/用户预设、采样参数与生成规划字段",
                onClick = onOpenPresets,
            )
            HubRow(
                title = "人设",
                subtitle = "默认人设与头像；会话可覆盖",
                onClick = onOpenPersonas,
            )
            HubRow(
                title = "快捷回复",
                subtitle = "全局与角色级集合、命令可用性",
                onClick = onOpenQuickReplies,
            )
            HubRow(
                title = "用量分析",
                subtitle = "按模型/角色/日期与成败分类，清空前显示影响",
                onClick = onOpenUsageInsights,
            )
            HubRow(
                title = "备份与恢复",
                subtitle = "跨平台 Backup V3；凭据与设备身份默认排除",
                onClick = onOpenBackup,
            )
        }
    }
}

@Composable
private fun HubRow(
    title: String,
    subtitle: String,
    onClick: (() -> Unit)?,
    pending: String? = null,
) {
    val enabled = onClick != null && pending == null
    Column(modifier = Modifier.fillMaxWidth()) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .then(if (enabled) Modifier.clickable { onClick?.invoke() } else Modifier)
                .padding(horizontal = 16.dp, vertical = 14.dp),
        ) {
            Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.titleSmall)
                Text(
                    subtitle,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (!enabled && pending != null) {
                    Text(
                        pending,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.tertiary,
                    )
                }
            }
            if (enabled) {
                Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null)
            }
        }
        Divider()
    }
}
