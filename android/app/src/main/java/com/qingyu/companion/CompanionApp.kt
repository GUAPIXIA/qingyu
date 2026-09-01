package com.qingyu.companion

import android.app.Application
import com.qingyu.companion.data.AppContainer
import coil.ImageLoader
import coil.ImageLoaderFactory
import okhttp3.OkHttpClient

/**
 * 应用入口：装配依赖图（Room / DataStore / 网络层），并恢复上次连接。
 * B-06：ConnectivityObserver 随本 Application 生命周期 start（进程存活期间不注销）；
 * 页面销毁不影响网络观察与 coordinator 重连循环。
 */
class CompanionApp : Application(), ImageLoaderFactory {

    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
        container.start()
    }

    /**
     * 静态媒体与 REST 使用同一 Bearer 认证；令牌不会进入图片 URL。
     * B-04：token 按 URL 所属 host:port 归属解析（旧页面图片可能指向非活跃 PC，
     * 永远拿"当前活跃 PC"的 token 会跨机串台/401）。
     */
    override fun newImageLoader(): ImageLoader =
        ImageLoader.Builder(this)
            .okHttpClient {
                OkHttpClient.Builder()
                    .connectionPool(container.networkStack.connectionPool)
                    .dispatcher(container.networkStack.dispatcher)
                    .addInterceptor { chain ->
                        val url = chain.request().url
                        val token = container.connectionCoordinator
                            .tokenForEndpoint(url.host, url.port)
                        val request = chain.request().newBuilder()
                            .header("User-Agent", "qingyu-companion-android/0.1")
                            .apply {
                                token?.takeIf { it.isNotBlank() }?.let {
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
