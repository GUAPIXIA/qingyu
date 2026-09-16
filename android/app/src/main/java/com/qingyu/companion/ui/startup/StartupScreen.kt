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
import com.qingyu.companion.data.StartupRepositoryImpl
import com.qingyu.companion.ui.components.AppBackground
import com.qingyu.companion.ui.theme.qyColors

/**
 * 启动决策页（A-03）：冷启动唯一的透明入口，只做本地快照读取与一次性导航分发。
 * 决策完成前不进入任何业务页，避免已配对用户闪现配对页；
 * 网络恢复由 AppContainer.start() 的异步 restore() 并行进行，本页不等待。
 */
@Composable
fun StartupScreen(
    onNeedsPairing: () -> Unit,
    onReady: (needsRepair: Boolean) -> Unit,
    onReadyWithoutActive: () -> Unit,
) {
    val container = LocalAppContainer.current
    val vm: StartupViewModel = viewModel(factory = viewModelFactory {
        initializer { StartupViewModel(StartupRepositoryImpl(container.connectionStore)) }
    })
    val state by vm.state.collectAsStateWithLifecycle()

    LaunchedEffect(state) {
        when (val s = state) {
            StartupState.LoadingLocalState -> Unit
            StartupState.NeedsPairing -> onNeedsPairing()
            // 阶段 3：本地资料就绪可直接进主界面；本地向导 UI 未就绪前暂回配对入口
            StartupState.LocalReady -> onReady(false)
            StartupState.NeedsLocalSetup -> onNeedsPairing()
            is StartupState.Ready -> onReady(s.needsRepair)
            is StartupState.ReadyWithoutActive -> onReadyWithoutActive()
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
