package com.qingyu.companion.ui.components

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.qingyu.companion.ui.theme.qyColors

/**
 * 选择行去重纯函数（A-02）：仅当点选项与当前值不同才返回新值；
 * 重复选择当前项返回 null，调用方据此跳过写入（避免重复 DataStore 提交）。
 * 纯 Kotlin，可脱离 Compose 做 JVM 单测。
 */
fun <T> resolveChoiceSelection(current: T, option: T): T? = option.takeIf { it != current }

/**
 * 通用设置选择行（A-02 修复主题选择）：点击弹出 [ModalBottomSheet]，
 * 用可复用 [SelectRow] 列出全部候选；选中非当前值才回调 [onSelect]。
 * 主题模式 / 聊天字体 / 消息间距等展开式选择统一复用本组件。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun <T> SettingsChoiceRow(
    title: String,
    selected: T,
    options: List<T>,
    labelOf: (T) -> String,
    subtitleOf: (T) -> String = { "" },
    onSelect: (T) -> Unit,
) {
    val qy = qyColors()
    var showSheet by remember { mutableStateOf(false) }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .clickable { showSheet = true }
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge, color = qy.text)
            Spacer(Modifier.height(2.dp))
            Text(
                labelOf(selected),
                style = MaterialTheme.typography.bodySmall,
                color = qy.soft,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Icon(
            Icons.Filled.ChevronRight,
            contentDescription = null,
            tint = qy.muted,
            modifier = Modifier.padding(start = 8.dp),
        )
    }

    if (showSheet) {
        val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
        ModalBottomSheet(
            onDismissRequest = { showSheet = false },
            containerColor = qy.card,
            sheetState = sheetState,
        ) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 8.dp)
                    .padding(bottom = 24.dp),
            ) {
                Text(
                    title,
                    style = MaterialTheme.typography.titleMedium,
                    color = qy.text,
                    modifier = Modifier.padding(start = 16.dp, top = 4.dp, bottom = 8.dp),
                )
                options.forEach { option ->
                    // 复用 QuickSettingsRows 的既有 SelectRow（圆形单选指示）
                    SelectRow(
                        selected = option == selected,
                        title = labelOf(option),
                        subtitle = subtitleOf(option).ifBlank { null },
                        onClick = {
                            showSheet = false
                            // 去重：选当前项不回调，不产生重复写入
                            resolveChoiceSelection(selected, option)?.let(onSelect)
                        },
                    )
                }
            }
        }
    }
}
