# =====================================================================
# 轻语伴侣端 release 混淆规则（阶段 G-04）
#
# 原则：
# - kotlinx.serialization：官方规则（PC 侧 + 本项目 DTO 均 @Serializable，
#   生成的 serializer 类必须保留，否则 release 构建缺类崩溃）；
# - Room：DAO/Entity 由 KSP 生成实现（如 CacheDatabase_Impl、*Dao_Impl），
#   反射/查询名映射需要 keep；Room 自带 consumer rules 覆盖主体，本文件
#   补显式 keep 防未来版本退化；
# - Coil 2.x：内部经反射实例化 ImageLoader/Keyer，官方建议 keep；
# - Media3/ExoPlayer、Retrofit 反射接口：库自带 consumer rules，一般无需
#   手写（见注释），仅对暴露给框架/反射的边界做 keep；
# - okhttp/kotlinx-coroutines：自带 consumer rules，无需手写。
# =====================================================================

# ---------------- kotlinx.serialization（官方规则，含 kotlinx 运行时） ----------------
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.AnnotationsKt
-keepclassmembers class kotlinx.serialization.json.** { *** Companion; }
-keepclasseswithmembers class kotlinx.serialization.json.** { kotlinx.serialization.KSerializer serializer(...); }
# 本项目所有 @Serializable DTO 的生成 serializer（含嵌套 $serializer）与伴生对象
-keep,includedescriptorclasses class com.qingyu.companion.**$$serializer { *; }
-keepclassmembers class com.qingyu.companion.** { *** Companion; }
-keepclasseswithmembers class com.qingyu.companion.** { kotlinx.serialization.KSerializer serializer(...); }

# ---------------- Room（实体/DAO 生成实现，KSP 生成于同一包下 *_Impl） ----------------
-keep class * extends androidx.room.RoomDatabase { <init>(); }
-keep class * implements androidx.room.RoomDatabase$* { <init>(); }
-keep class com.qingyu.companion.data.CacheDatabase { *; }
-keep class com.qingyu.companion.data.** { *; }
# Room 生成的 DAO/DB 实现类（KSP 产物，类名以 _Impl 结尾）
-keep class * extends androidx.room.RoomDatabase { *; }
-keep class * extends androidx.room.RoomDatabase_Impl { *; }
-keepclassmembers class * { @androidx.room.* <methods>; }
-keepclassmembers class * { @androidx.room.* <fields>; }
-keepclassmembers class * { @androidx.room.Entity <fields>; }
-keepclasseswithmembers class com.qingyu.companion.data.** { @androidx.room.* <methods>; }

# ---------------- Coil 2.x（ImageLoader/Keyer 等经反射装配） ----------------
-keep class coil.** { *; }
-keepclassmembers class coil.** { *; }
-dontwarn coil.**

# ---------------- Media3 / ExoPlayer（TTS 与消息音频播放） ----------------
# Media3 自带 consumer rules；此处仅 keep 应用直接持有的播放器边界，防混淆后
# 反射构造（ExoPlayer.Builder）与自定义 MediaSource 工厂失效。
-keep class androidx.media3.** { *; }
-dontwarn androidx.media3.**

# ---------------- Retrofit 反射接口 ----------------
# 接口方法签名经反射生成实现；接口本身必须保留方法名（库 consumer rules
# 一般已覆盖，显式 keep 防 AGP/R8 版本差异）。
-keep,allowobfuscation,allowshrinking interface com.qingyu.companion.network.QingyuApi
-keepclassmembers interface com.qingyu.companion.network.QingyuApi { *; }

# ---------------- AndroidX / 其他（显式边界，防误裁） ----------------
-keep class com.qingyu.companion.CompanionApp { <init>(); }
-keep class com.qingyu.companion.MainActivity { <init>(); }
# 安全加密（DataStore + Keystore 密文偏好）与生物识别回调
-keepclassmembers class com.qingyu.companion.security.** { *; }
# ZXing 扫描 Activity（Manifest 引用，框架按名称加载）
-keep class com.journeyapps.barcodescanner.** { *; }
-dontwarn com.journeyapps.barcodescanner.**
# 序列化模型对象的 Kotlin 属性访问器（Compose 状态读取）
-keepclassmembers class com.qingyu.companion.model.** { public *** get*(); public void set*(***); }

# ---------------- 库自带 consumer rules 说明（无需手写） ----------------
# okhttp3 / kotlinx-coroutines / kotlinx.serialization-json（除上方官方 keep 外）/
# androidx.room / androidx.media3 / coil 均随 AAR 携带 consumer rules；
# 若未来 R8 报 Missing class / 反射缺类，优先升级库版本而非加宽 keep。
