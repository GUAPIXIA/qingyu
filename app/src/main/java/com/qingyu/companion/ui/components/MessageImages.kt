package com.qingyu.companion.ui.components

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import coil.request.ImageRequest
import java.util.Base64

/**
 * 消息图片渲染（方案 §3.3 生图结果回传消费侧）。
 *
 * 图片来源两种（桥接层转换约定，见 docs/安卓伴侣端方案.md §4.2）：
 * - `http(s)://...`：桥接层白名单静态路由 URL（tavern:// 安卓端不可达）——Coil 加载；
 * - base64 / `data:image/...;base64,...`：PC 侧原生 base64（桥接层未转换时兜底）——解码为 Bitmap。
 *
 * 点击单图或图集打开全屏大图查看（[ImageViewerDialog]，HorizontalPager 左右滑动）。
 */

/** 判断图片源类型并归一化为可加载模型 */
sealed interface ImageSource {
    data class Url(val url: String) : ImageSource
    data class Base64(val bytes: ByteArray) : ImageSource
}

/** 归一化图片源：http(s) URL / data URI / 纯 base64 各自识别；空串与无效数据返回 null */
fun resolveImageSource(raw: String): ImageSource? {
    val trimmed = raw.trim()
    if (trimmed.isEmpty()) return null
    return when {
        trimmed.startsWith("http://") || trimmed.startsWith("https://") ->
            ImageSource.Url(trimmed)

        trimmed.startsWith("data:image") -> {
            val comma = trimmed.indexOf(',')
            if (comma <= 0) return null
            val b64 = trimmed.substring(comma + 1)
            decodeBase64(b64)?.let { ImageSource.Base64(it) }
        }

        else -> decodeBase64(trimmed)?.let { ImageSource.Base64(it) }
    }
}

/**
 * 解码 base64（MIME 宽松模式忽略空白）。
 * 解码后做图片魔数校验（防配对码等纯文本被误判为图片），JVM 单测可覆盖。
 */
fun decodeBase64(raw: String): ByteArray? {
    val bytes = runCatching { Base64.getMimeDecoder().decode(raw) }.getOrNull() ?: return null
    return if (isImageBytes(bytes)) bytes else null
}

/**
 * 魔数校验常见图片格式（PNG / JPEG / GIF / WebP / BMP）。
 * 与 BitmapFactory 校验等价但不依赖 Android 运行时，便于 JVM 单测。
 */
fun isImageBytes(bytes: ByteArray): Boolean {
    if (bytes.size < 12) return false
    val b = bytes
    return when {
        // PNG: 89 50 4E 47
        b[0] == 0x89.toByte() && b[1] == 'P'.code.toByte() &&
            b[2] == 'N'.code.toByte() && b[3] == 'G'.code.toByte() -> true

        // JPEG: FF D8 FF
        b[0] == 0xFF.toByte() && b[1] == 0xD8.toByte() && b[2] == 0xFF.toByte() -> true

        // GIF: 47 49 46 38 ('GIF8')
        b[0] == 'G'.code.toByte() && b[1] == 'I'.code.toByte() &&
            b[2] == 'F'.code.toByte() && b[3] == '8'.code.toByte() -> true

        // WebP: RIFF....WEBP
        b[0] == 'R'.code.toByte() && b[1] == 'I'.code.toByte() &&
            b[2] == 'F'.code.toByte() && b[3] == 'F'.code.toByte() &&
            b[8] == 'W'.code.toByte() && b[9] == 'E'.code.toByte() &&
            b[10] == 'B'.code.toByte() && b[11] == 'P'.code.toByte() -> true

        // BMP: 42 4D ('BM')
        b[0] == 'B'.code.toByte() && b[1] == 'M'.code.toByte() -> true

        else -> false
    }
}

/** 按目标宽度采样解码，防 OOM（聊天图通常不需要原尺寸） */
fun decodeBitmapSampled(bytes: ByteArray, maxDim: Int = 2048): Bitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    var sample = 1
    while (bounds.outWidth / sample > maxDim || bounds.outHeight / sample > maxDim) {
        sample *= 2
    }
    val opts = BitmapFactory.Options().apply { inSampleSize = sample }
    return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)
}

@Composable
fun MessageImages(
    images: List<String>,
    modifier: Modifier = Modifier,
    onImageClick: (index: Int) -> Unit = {},
) {
    // 单图全宽，多图两列平铺（手机聊天最常见布局）
    if (images.isEmpty()) return
    if (images.size == 1) {
        SingleImage(source = resolveImageSource(images[0]), onClick = { onImageClick(0) }, modifier = modifier)
        return
    }
    Row(
        modifier = modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        images.take(2).forEachIndexed { index, raw ->
            Box(
                modifier = Modifier
                    .weight(1f)
                    .aspectRatio(1f)
                    .clip(RoundedCornerShape(8.dp))
                    .clickable { onImageClick(index) },
            ) {
                SingleImage(source = resolveImageSource(raw), onClick = null, modifier = Modifier.fillMaxSize())
            }
        }
    }
}

@Composable
private fun SingleImage(
    source: ImageSource?,
    onClick: (() -> Unit)?,
    modifier: Modifier = Modifier,
) {
    when (source) {
        is ImageSource.Url -> AsyncImage(
            model = ImageRequest.Builder(LocalContext.current)
                .data(source.url)
                .crossfade(true)
                .build(),
            contentDescription = "消息图片",
            contentScale = ContentScale.Crop,
            modifier = modifier
                .clip(RoundedCornerShape(8.dp))
                .let { if (onClick != null) it.clickable(onClick = onClick) else it },
        )

        is ImageSource.Base64 -> {
            val bitmap by produceState<Bitmap?>(initialValue = null, key1 = source) {
                value = decodeBitmapSampled(source.bytes)
            }
            bitmap?.let {
                Image(
                    bitmap = it.asImageBitmap(),
                    contentDescription = "消息图片",
                    contentScale = ContentScale.Crop,
                    modifier = modifier
                        .clip(RoundedCornerShape(8.dp))
                        .let { m -> if (onClick != null) m.clickable(onClick = onClick) else m },
                )
            }
        }

        null -> Box(
            modifier = modifier
                .size(120.dp)
                .clip(RoundedCornerShape(8.dp)),
            contentAlignment = Alignment.Center,
        ) {
            Text("图片", style = MaterialTheme.typography.labelSmall)
        }
    }
}

/** 全屏大图查看：HorizontalPager 左右滑动，顶部返回栏显示页码 */
@OptIn(ExperimentalFoundationApi::class, ExperimentalMaterial3Api::class)
@Composable
fun ImageViewerDialog(
    images: List<String>,
    initialIndex: Int,
    onDismiss: () -> Unit,
) {
    val pagerState = rememberPagerState(initialPage = initialIndex) { images.size }
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("${pagerState.currentPage + 1} / ${images.size}") },
                navigationIcon = {
                    IconButton(onClick = onDismiss) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                },
            )
        },
    ) { padding ->
        HorizontalPager(
            state = pagerState,
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
        ) { page ->
            val source = resolveImageSource(images[page])
            when (source) {
                is ImageSource.Url -> AsyncImage(
                    model = source.url,
                    contentDescription = "大图",
                    contentScale = ContentScale.Fit,
                    modifier = Modifier.fillMaxSize(),
                )

                is ImageSource.Base64 -> {
                    val bitmap by produceState<Bitmap?>(initialValue = null, key1 = source) {
                        value = decodeBitmapSampled(source.bytes, maxDim = 4096)
                    }
                    bitmap?.let {
                        Image(
                            bitmap = it.asImageBitmap(),
                            contentDescription = "大图",
                            contentScale = ContentScale.Fit,
                            modifier = Modifier.fillMaxSize(),
                        )
                    }
                }

                null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Text("无法加载图片")
                }
            }
        }
    }
}
