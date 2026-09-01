// 顶层构建文件：插件声明统一走 gradle/libs.versions.toml
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.android.test) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.kotlin.serialization) apply false
    alias(libs.plugins.ksp) apply false
    // benchmark/baselineprofile 插件保留声明（G-01/G-02 后续真机接入时启用），
    // 当前 :benchmark 模块按官方 Macrobenchmark 模板只依赖运行时，不应用 gradle 插件
    alias(libs.plugins.androidx.benchmark) apply false
    alias(libs.plugins.androidx.baselineprofile) apply false
}
