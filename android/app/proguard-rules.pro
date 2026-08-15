# kotlinx.serialization
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.AnnotationsKt
-keepclassmembers class kotlinx.serialization.json.** { *** Companion; }
-keepclasseswithmembers class kotlinx.serialization.json.** { kotlinx.serialization.KSerializer serializer(...); }
-keep,includedescriptorclasses class com.qingyu.companion.**$$serializer { *; }
-keepclassmembers class com.qingyu.companion.** { *** Companion; }
-keepclasseswithmembers class com.qingyu.companion.** { kotlinx.serialization.KSerializer serializer(...); }
