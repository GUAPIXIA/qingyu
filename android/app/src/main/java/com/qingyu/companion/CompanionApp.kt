package com.qingyu.companion

import android.app.Application
import com.qingyu.companion.data.AppContainer

/**
 * 应用入口：装配依赖图（Room / DataStore / 网络层），并恢复上次连接。
 */
class CompanionApp : Application() {

    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
        container.start()
    }
}
