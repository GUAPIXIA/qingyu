package com.qingyu.companion.ui.pairing

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.slideInVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import com.qingyu.companion.data.LocalAppContainer
import com.qingyu.companion.model.ServerConnection
import com.qingyu.companion.network.DiscoveredPc
import com.qingyu.companion.ui.components.AppBackground
import com.qingyu.companion.ui.components.AppTopBar
import com.qingyu.companion.ui.theme.qyColors


/** 卡片容器：纯色底 + 1dp 细描边，无阴影 */
@Composable
fun GlassCard(
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    val qy = qyColors()
    Surface(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        color = qy.bg2,
        border = androidx.compose.foundation.BorderStroke(1.dp, qy.line),
    ) {
        Column(
            Modifier.padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            content()
        }
    }
}

/** 圆角输入框：bg2 底 + line 描边 */

/** 圆角输入框：bg2 底 + line 描边 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GlassTextField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    modifier: Modifier = Modifier,
) {
    val qy = qyColors()
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        label = { Text(label) },
        modifier = modifier,
        singleLine = true,
        shape = RoundedCornerShape(12.dp),
        colors = OutlinedTextFieldDefaults.colors(
            focusedContainerColor = qy.bg2,
            unfocusedContainerColor = qy.bg2,
            focusedTextColor = qy.text,
            unfocusedTextColor = qy.text,
            focusedBorderColor = qy.accent,
            unfocusedBorderColor = qy.line,
            focusedLabelColor = qy.accent,
            unfocusedLabelColor = qy.soft,
        ),
    )
}

@Composable
internal fun DiscoveredPcRow(pc: DiscoveredPc, onClick: () -> Unit) {
    val qy = qyColors()
    Surface(
        shape = RoundedCornerShape(14.dp),
        color = qy.bg2,
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
    ) {
        Row(
            Modifier.padding(horizontal = 14.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // 信号点
            Box(
                Modifier
                    .size(8.dp)
                    .clip(CircleShape)
                    .background(qy.accent)
            )
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    pc.name.ifBlank { "未命名 PC" },
                    style = MaterialTheme.typography.bodyLarge,
                    color = qy.text,
                )
                Text(
                    "${pc.host}:${pc.port}",
                    style = MaterialTheme.typography.labelSmall,
                    color = qy.soft,
                )
            }
            Text(
                "填入",
                style = MaterialTheme.typography.labelMedium,
                color = qy.accent,
            )
        }
    }
}

@Composable
internal fun ConnectionRow(
    connection: ServerConnection,
    isActive: Boolean,
    onEnter: () -> Unit,
    onSwitch: () -> Unit,
    onRemove: () -> Unit,
) {
    val qy = qyColors()
    Surface(
        shape = RoundedCornerShape(14.dp),
        color = if (isActive) qy.accentSoft else qy.bg2,
        border = androidx.compose.foundation.BorderStroke(
            1.dp,
            if (isActive) qy.accent else qy.line,
        ),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(
            Modifier.padding(horizontal = 16.dp, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                Modifier
                    .size(10.dp)
                    .clip(CircleShape)
                    .background(
                        if (isActive) qy.ok else qy.line,
                    )
            )
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    connection.name,
                    style = MaterialTheme.typography.bodyLarge,
                    color = qy.text,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        "${connection.host}:${connection.port}",
                        style = MaterialTheme.typography.labelSmall,
                        color = qy.soft,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                    if (isActive) {
                        Spacer(Modifier.width(6.dp))
                        // 「当前」徽章移到副行，避免与右侧按钮/名称行挤压重叠
                        Surface(
                            shape = RoundedCornerShape(percent = 50),
                            color = qy.accentSoft,
                        ) {
                            Text(
                                "当前",
                                style = MaterialTheme.typography.labelSmall,
                                color = qy.accent,
                                modifier = Modifier.padding(horizontal = 5.dp, vertical = 1.dp),
                            )
                        }
                    }
                }
            }
            if (isActive) {
                Button(
                    onClick = onEnter,
                    shape = RoundedCornerShape(percent = 50),
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 14.dp, vertical = 6.dp),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = qy.accentSoft,
                        contentColor = qy.accent,
                    ),
                ) {
                    Text("进入", style = MaterialTheme.typography.labelLarge)
                }
            } else {
                Surface(
                    onClick = onSwitch,
                    shape = RoundedCornerShape(percent = 50),
                    color = qy.bg2,
                    border = androidx.compose.foundation.BorderStroke(1.dp, qy.line),
                ) {
                    Text(
                        "切换",
                        style = MaterialTheme.typography.labelLarge,
                        color = qy.soft,
                        modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp),
                    )
                }
            }
            IconButton(onClick = onRemove) {
                Icon(
                    Icons.Filled.Delete,
                    contentDescription = "移除",
                    tint = qy.danger,
                )
            }
        }
    }
}

/** 构建 ZXing 扫码配置（仅 QR_CODE，提示语指向 PC 端配对二维码） */

/** 构建 ZXing 扫码配置（仅 QR_CODE，提示语指向 PC 端配对二维码） */
internal fun scanOptions(): ScanOptions =
    ScanOptions().apply {
        setDesiredBarcodeFormats(ScanOptions.QR_CODE)
        setPrompt("扫描 PC 端配对二维码")
        setBeepEnabled(false)
    }
