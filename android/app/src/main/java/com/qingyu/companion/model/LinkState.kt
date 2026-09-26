package com.qingyu.companion.model

/**
 * 链路状态（S9-07：原 network.LinkState）。
 * 本地权威库模式下语义为「本地数据源可用」，保留枚举以兼容 UI 离线文案。
 */
enum class LinkState { DISCONNECTED, CONNECTING, CONNECTED, RECONNECTING }
