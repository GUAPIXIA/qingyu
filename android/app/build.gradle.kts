plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
}

android {
    namespace = "com.qingyu.companion"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.qingyu.companion"
        minSdk = 26
        targetSdk = 34
        // 版本号统一在 gradle/libs.versions.toml 的 [versions] 中管理，发布时仅改一处
        versionCode = libs.versions.appVersionCode.get().toInt()
        versionName = libs.versions.appVersionName.get()

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        release {
            // G-04：正式开启 R8 代码压缩 + 资源压缩（此前 isMinifyEnabled=false）
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            // G-04 签名：CI/正式发布经环境变量注入密钥（ANDROID_KEYSTORE_*，见 .github/workflows/release.yml）；
            // 本机未配置时回退 debug 签名——仅用于本地冒烟验证，正式发布必须走 CI secret。
            // 注意：debug 签名证书是公开的，回退产物不得对外分发。
            signingConfig = if (
                System.getenv("ANDROID_KEYSTORE_PATH")?.isNotBlank() == true &&
                System.getenv("ANDROID_KEYSTORE_PASSWORD")?.isNotBlank() == true &&
                System.getenv("ANDROID_KEY_ALIAS")?.isNotBlank() == true &&
                System.getenv("ANDROID_KEY_PASSWORD")?.isNotBlank() == true
            ) {
                signingConfigs.create("release") {
                    storeFile = file(System.getenv("ANDROID_KEYSTORE_PATH"))
                    storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
                    keyAlias = System.getenv("ANDROID_KEY_ALIAS")
                    keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
                }
            } else {
                logger.warn("未检测到 ANDROID_KEYSTORE_PATH/PASSWORD/ALIAS/KEY_PASSWORD 环境变量，" +
                    "release 构建回退使用 debug 签名（仅限本地冒烟，禁止对外发布）")
                signingConfigs.getByName("debug")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    // 阶段 3：Room migration / 外键 / Repository 契约测试在 JVM 上执行（不依赖模拟器）。
    // androidTest 仍负责 API 26/31/34 的 Keystore 与网络安全 instrumentation。
    //
    // 阶段 5 U-10：本机 SDK 已装 android-26/31/34 的 **aosp x86_64** 镜像，
    // 因此用 Gradle Managed Devices 声明总方案 §11.1/§11.2 要求的三档设备。
    // 为什么必须声明在构建里而不是「手点模拟器再 connectedAndroidTest」：
    // 后者依赖某个人的机器状态，别人和 CI 都无法复现，门禁就会退化成口头承诺。
    testOptions {
        managedDevices {
            localDevices {
                // API 26（Android 8）：Minikin/Keystore 行为最旧的一档
                //
                // 设备档位 2026-09-20 由 `Nexus 5` 改为 `Pixel 2`，但**它不是一处修复**，
                // 别把它读成「换了档位就好了」：
                // - 现象是**全量 59 条同实例**跑完时，后段的交互走查用例偶尔红在
                //   `SQLiteDiskIOException: disk I/O error (code 522)`（打开数据库阶段，
                //   不是断言失败）；同类单跑 3/3、任意两类子集同跑 7/7 都绿。
                // - 换成 Pixel 2 后有过一次全量 59/0，当时据此记成「档位存储不够用」；
                //   **随后在同一个 Pixel 2 档位上，同样的两条用例又以同样的 522 红了**
                //   —— 单次绿是巧合，档位不是差异变量，那条因果结论已作废（见报告 §3.2(2)）。
                // - 保留这次对齐的理由只剩下两条：与 api31/api34 一致（报告一直写的是
                //   「三档都是 Pixel 2」），以及两者同为 1080x1920 xxhdpi、点击坐标类用例不受影响。
                // **仍未解决**：机制未定位。下一步要么在用例里读一次 `StatFs` 把「磁盘要满」
                // 从推断变成实测，要么把 59 条拆到两个模拟器实例上跑。
                create("pixel2Api26") {
                    device = "Pixel 2"
                    apiLevel = 26
                    systemImageSource = "aosp"
                }
                create("pixel2Api31") {
                    device = "Pixel 2"
                    apiLevel = 31
                    systemImageSource = "aosp"
                }
                create("pixel2Api34") {
                    device = "Pixel 2"
                    apiLevel = 34
                    systemImageSource = "aosp"
                }
            }
            groups {
                // 一次跑齐三档：`./gradlew :app:deviceMatrixAndroidTest`
                create("deviceMatrix") {
                    targetDevices.add(devices["pixel2Api26"])
                    targetDevices.add(devices["pixel2Api31"])
                    targetDevices.add(devices["pixel2Api34"])
                }
            }
        }
        unitTests {
            isIncludeAndroidResources = true
        }
    }
}

// S3-01 要求用「保存的历史 schema」做 MigrationTestHelper 校验，
// 因此把导出的 schemas 目录作为单元测试 assets（只影响测试 APK，不进生产包）。
android.sourceSets.getByName("test").assets.srcDir("$projectDir/schemas")
// 阶段 4 S4-05：真机迁移测试同样需要历史 schema（MigrationTestHelper 从 assets 读取）。
// 这一行同时把「app/schemas 必须提交入库」从提交卫生提升为**测试前置**：
// 缺少 <version>.json 时迁移测试一定会失败，而不是静默跳过。
android.sourceSets.getByName("androidTest").assets.srcDir("$projectDir/schemas")

// Room schema 导出（F-05）：KSP 参数指定 schemas 目录。
// 每次 version 升级生成 app/schemas/com.qingyu.companion.data.CacheDatabase/<version>.json，
// 随仓库保留，供后续版本迁移验证（MigrationTestHelper）与回滚审计（方案 §16.3）。
ksp {
    arg("room.schemaLocation", "$projectDir/schemas")
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.viewmodel.ktx)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.process)
    implementation(libs.androidx.activity.compose)

    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons.core)
    // 现代 Material 官方图标全集（Reply/Translate/VolumeUp 等；release 经 R8 裁剪无用图标）
    implementation(libs.androidx.compose.material.icons.extended)
    implementation(libs.androidx.navigation.compose)

    // 网络层：Retrofit + OkHttp（REST）+ OkHttp WebSocket（流式）
    implementation(libs.retrofit)
    implementation(libs.okhttp)
    implementation(libs.okhttp.logging)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.retrofit.kotlinx.serialization)
    implementation(libs.kotlinx.coroutines.android)

    // 本地缓存：Room（仅最近会话，离线只读）
    implementation(libs.androidx.room.runtime)
    implementation(libs.androidx.room.ktx)
    ksp(libs.androidx.room.compiler)

    // 配对令牌/连接配置持久化（DataStore + Keystore 加密）
    implementation(libs.androidx.datastore.preferences)
    implementation(libs.androidx.security.crypto)
    // 应用锁：生物识别/设备凭据（路线图 4.3）
    implementation(libs.androidx.biometric)

    // TTS 音频流播放（独立 HTTP 流，边下边播）
    implementation(libs.media3.exoplayer)

    // 角色封面/生图结果加载
    implementation(libs.coil.compose)

    // 扫码配对（方案 §5.1 主路径）
    implementation(libs.zxing.android.embedded)

    testImplementation(libs.junit)
    // 阶段 5：非 Robolectric 的纯 JVM 单测里 `org.json` 是 android.jar 的**未实现桩**
    // （调用即抛 "Method ... not mocked"）。规范 payload 现在会在写实体时解析
    // extensions / canonicalJson 等 JSON 列，因此测试类路径需要真正的 org.json 实现。
    // 不加这条，阶段 4 的 LocalChatRepository/GenerationUseCase 全套会因此变红。
    testImplementation("org.json:json:20240303")
    // 阶段 5：内容管理编解码测试使用 kotlin.test 的断言签名
    // （assertEquals(expected, actual, message)），消息参数在最后，便于把「哪个字段与 PC 不一致」
    // 写进断言消息；JUnit 的 assertEquals 把消息放首位，批量改写断言参数顺序更容易出错。
    testImplementation(kotlin("test"))
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.core)
    testImplementation(libs.androidx.room.testing)
    androidTestImplementation(libs.androidx.test.ext.junit)
    // 阶段 4 S4-05：迁移测试需要 MigrationTestHelper（真实 SQLite）
    androidTestImplementation(libs.androidx.room.testing)
    androidTestImplementation(libs.androidx.espresso.core)
    // 阶段0 spike：系统 Provider 无 Ed25519 时用 BC 实现验证（仅测试 APK）
    androidTestImplementation(libs.bouncycastle.prov)
    // 阶段 5 §11.1：内容管理八条入口的 Compose 交互层走查。BOM 只管 implementation 那条链，
    // androidTest 必须自己再 platform() 一次，否则 ui-test 的传递依赖会脱离 BOM 版本约束。
    androidTestImplementation(platform(libs.androidx.compose.bom))
    androidTestImplementation(libs.androidx.compose.ui.test.junit4)
    // createComposeRule 需要一个承载 ComposeHost 的 Activity，由 ui-test-manifest 在 debug 变体里注入。
    debugImplementation(libs.androidx.compose.ui.test.manifest)
    debugImplementation(libs.androidx.compose.ui.tooling)
}

// 阶段 4：文案守卫测试直接读取 res/values/strings.xml（Gradle 不知道这个依赖）。
// 不声明输入的话，只改资源时该测试会被判定 UP-TO-DATE 而**静默跳过**——
// 「守卫看起来在跑，其实没跑」比没有守卫更危险。这里显式声明文件输入。
tasks.withType<Test>().configureEach {
    // 声明输入即可：Gradle 会在 strings.xml 变化时让测试重跑，其余情况保持增量。
    inputs.file("src/main/res/values/strings.xml").withPropertyName("stringsXmlForCopyGuard")
}