// 安卓伴侣端子项目（详见 docs/安卓伴侣端方案.md）
// 定位：PC 端的远程控制器与对话延伸，不做本地 AI 对话
pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        maven("https://maven.aliyun.com/repository/google")
        maven("https://maven.aliyun.com/repository/gradle-plugin")
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        maven("https://maven.aliyun.com/repository/google")
        maven("https://maven.aliyun.com/repository/public")
        mavenCentral()
        mavenLocal()
    }
}

rootProject.name = "qingyu-companion"
include(":app")
// G-01 性能基线 benchmark 模块（com.android.test + androidx.benchmark，需真机/模拟器运行）
include(":benchmark")
