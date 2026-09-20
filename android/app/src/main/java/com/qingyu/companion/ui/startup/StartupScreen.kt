package com.qingyu.companion.ui.startup

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.layout.size
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.qingyu.companion.data.LocalAppContainer
import com.qingyu.companion.ui.components.AppBackground
import com.qingyu.companion.ui.theme.qyColors

/**
 * 启动决策页：冷启动唯一的透明入口，只做**本地**快照读取与一次性导航分发。
 *
 * 决策完成前不进入任何业务页；网络恢复由 AppContainer.start() 的异步 restore() 并行进行。
 * **本页不存在「需要配对 PC」的分支**（阶段 4 完成定义：导航中不得留有旧伴侣模式回退入口）：
 * 本地就绪进主界面，否则进本地初始化向导。PC 连接只由用户在设置/会话页主动发起。
 */
@Composable
fun StartupScreen(
    onReady: () -> Unit,
    onNeedsLocalSetup: () -> Unit,
) {
    val container = LocalAppContainer.current
    val vm: StartupViewModel = viewModel(factory = viewModelFactory {
        initializer {
            StartupViewModel(
                localSnapshotProvider = { container.localStartupSnapshot() },
            )
        }
    })
    val state by vm.state.collectAsStateWithLifecycle()

    LaunchedEffect(state) {
        when (state) {
            StartupState.LoadingLocalState -> Unit
            // 本地资料就绪不再依赖 PC；未初始化时进入本地向导
            StartupState.LocalReady -> onReady()
            StartupState.NeedsLocalSetup -> onNeedsLocalSetup()
        }
    }

    AppBackground {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                Text(
                    "轻语",
                    style = MaterialTheme.typography.headlineMedium,
                    fontWeight = FontWeight.Bold,
                    color = qyColors().text,
                )
                Spacer(Modifier.height(20.dp))
                if (state == StartupState.LoadingLocalState) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(24.dp),
                        strokeWidth = 2.dp,
                        color = qyColors().accent,
                    )
                }
            }
        }
    }
}
