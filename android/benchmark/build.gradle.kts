// G-01 性能基线模块（实施文档 §11 G-01/G-02）。
//
// 结构：官方 Macrobenchmark 模板 = com.android.test（instrumented 测试 APK）
// + androidx.benchmark:benchmark-macro-junit4（运行时），**不应用** androidx.benchmark
// gradle 插件——benchmark-gradle-plugin 1.2.4 仅支持 library 模块（用于 baseline profile
// 生成），其自身报错信息即说明 "to run macrobenchmarks, this plugin is not required"。
// 对已安装的 :app 运行测量：
//  - 冷启动到 MainShell（StartupBenchmark）
//  - 打开 200/1000 条消息会话（SessionOpenBenchmark）
//  - 长列表 fling / 流式 chunk 帧稳定性（LongChatScrollBenchmark）
//
// 兼容性结论（已实测验证）：
//  - com.android.test 8.5.2 由 AGP 8.5.2 内置（根 build.gradle.kts 以 apply false 声明）；
//  - benchmark-macro-junit4 1.2.4 传递引入 benchmark-macro / junit4 核心；
//  - 运行门禁（真机，模拟器数据不代表真机）：
//      ./gradlew :app:installDebug
//      ./gradlew :benchmark:connectedBenchmarkAndroidTest
//    注意：无 profileable 变体时任务会失败，真机需 Android 12+ 的 profileable 支持
//    （release 变体自带；debug 变体需在 :app manifest 加 android:profileable="shell"，
//    或使用 benchmark 插件的 profileable 目标——详见实施文档 §G-01 后续步骤）。
plugins {
    id("com.android.test")
    alias(libs.plugins.kotlin.android)
}

android {
    namespace = "com.qingyu.companion.benchmark"
    compileSdk = 34

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    defaultConfig {
        minSdk = 26
        targetSdk = 34
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    // 被测目标应用：benchmark APK 与 :app 关联（com.android.test 扩展提供）
    targetProjectPath = ":app"
    experimentalProperties["android.experimental.self-instrumenting"] = true
}

dependencies {
    implementation(libs.androidx.benchmark.macro.junit4)
    implementation(libs.androidx.test.uiautomator)
    implementation(libs.androidx.test.ext.junit)
}

// ---------------------------------------------------------------------
// Baseline Profile 骨架（G-02）：
// androidx.baselineprofile 插件（1.2.4）与 AGP 8.5.2 兼容，接入方式：
//   1. :app 模块 plugins 增加 alias(libs.plugins.androidx.baselineprofile)
//      （app 为 com.android.application，支持该插件）；
//   2. 新建 :baselineprofile 模块（com.android.test + androidx.baselineprofile:
//      baselineprofile-testing 依赖 + 收集规则类）；
//   3. 真机（Pixel 等 profileable 设备）执行
//      ./gradlew :baselineprofile:generateBaselineProfile，
//      生成 app/src/main/generated/baselineProfiles/baseline-prof.txt，
//      随 :app release 构建自动打入 APK（AGP 原生支持）。
// 本骨架暂不创建 :baselineprofile 模块（依赖真机接入，见实施文档 §G-02），
// 覆盖路径：启动 -> 会话列表 -> 打开会话 -> 输入 -> 发送 -> 返回。
// ---------------------------------------------------------------------
