package com.qingyu.companion

import android.app.Application
import com.qingyu.companion.data.AppContainer
import coil.ImageLoader
import coil.ImageLoaderFactory
import okhttp3.OkHttpClient

/**
 * 应用入口：装配依赖图（Room / DataStore / 网络层），并恢复上次连接。
 */
class CompanionApp : Application(), ImageLoaderFactory {

    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
        container.start()
    }

    /** 静态媒体与 REST 使用同一 Bearer 认证；令牌不会进入图片 URL。 */
    override fun newImageLoader(): ImageLoader =
        ImageLoader.Builder(this)
            .okHttpClient {
                OkHttpClient.Builder()
                    .addInterceptor { chain ->
                        val connection = container.connectionManager.activeConnection
                        val request = chain.request().newBuilder()
                            .header("User-Agent", "qingyu-companion-android/0.1")
                            .apply {
                                connection?.token?.takeIf { it.isNotBlank() }?.let {
                                    header("Authorization", "Bearer $it")
                                }
                            }
                            .build()
                        chain.proceed(request)
                    }
                    .build()
            }
            .build()
}
