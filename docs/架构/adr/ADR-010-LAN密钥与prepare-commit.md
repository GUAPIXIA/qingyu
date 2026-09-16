# ADR-010: LAN 持久化 prepare/commit 与 X25519+一次性 secret；服务器新设备带外二维码/SAS

- 状态：已接受（**API 35 模拟器实机 spike 已通过**；Android 8/12/14 真机矩阵仍待补）
- 日期：2026-09-16
- 决策阶段：阶段 0（关联总方案决策门 5、6）

## 背景

LAN 同步需防不可信 Wi-Fi 与中间人；commit 丢失/进程重启不得导致半套数据。服务器模式新设备加入需带外认证；Android Keystore 未必可导入任意 32 字节密钥。

## 选择

### LAN

- 独立 `/sync/v1` 与授权 scope；5 分钟一次性会话二维码。
- 二维码携带：PC 临时 X25519 公钥、256 位一次性 secret、过期时间、TLS/应用公钥指纹。
- 双方从 ECDH transcript 派生会话密钥；PC 二次确认页显示同一短认证串（SAS）。
- 传输仍做应用层加密与完整性校验。
- 采用持久化 **prepare/commit**：commit 前 staging + `preparedReceipt`；任意端重启可查询会话前滚或安全放弃；禁止依赖内存态重放业务批次。

### 服务器新设备授权

- 新设备持有长期身份密钥（X25519 密钥交换 + Ed25519 签名）。
- 批准：已有设备扫新设备二维码或人工核对 SAS；绑定 `deviceId`、身份公钥、空间与 nonce 后加密封装 `spaceKey`。
- 服务端只转交带批准设备签名的密钥信封。

### Android 密钥保存

- 不假定 Keystore 可导入任意 32 字节 `spaceKey`；使用 Keystore 生成的不可导出 wrapping key 加密保存 `spaceKey`。
- Android 8 所需 X25519/Ed25519 实现与密码提供方必须在具备 SDK/设备的环境补做实机验证。
- **阶段 0 补测（2026-09-16，MuMu API 35 / V2364A，`CryptoSpikeTest` 6/6）：**
  - Keystore AES-GCM wrapping 加密封存 32 字节 `spaceKey`：**通过**（round-trip + 密钥不可导出）。
  - AndroidKeyStore X25519：**本模拟器不可用**（`NoSuchAlgorithmException`）；X25519 ECDH 改用系统 Conscrypt（`AndroidOpenSSL`）：**通过**。
  - AndroidKeyStore Ed25519：可生成但系统 JCA Signature 无完整 Ed25519；以 **androidTest-only BouncyCastle Ed25519** 验证签名/验签：**通过**。
  - 含义：生产实现不得假定 Keystore 内 X25519/Ed25519；身份密钥可用软件/Conscrypt+BC 或后续引入正式密码库，`spaceKey` 仍用 Keystore wrapping。若产品要求长期身份密钥也不可导出，需另评估 TEE/StrongBox 与库策略。

## 否决方案

1. **直接把 secret 或 PAKE 细节留给实现临时发挥**：否决。总方案禁止。
2. **LAN 明文 HTTP 无应用层加密**：否决。
3. **commit 仅内存事务、无 preparedReceipt**：否决。重启后无法安全恢复。

## 后果

- 阶段 7 实现必须落盘会话状态机与恢复查询。
- 阶段 8 落地密钥信封与吊销；空间密钥轮换与业务版本向量分离。

## 重新评估条件

- 实机证明选定 Provider 在目标 API 级别无法满足 X25519/Ed25519 时，**必须修订本 ADR** 再进入阶段 7/8 编码，不得实现期偷偷换算法。
- 已在 API 35 模拟器确认：Keystore 无 X25519/完整 Ed25519 JCA；阶段 7/8 编码以「Keystore wrap spaceKey + 软件身份密钥（Conscrypt/BC）」为基线，除非 Android 8/12 真机或产品要求推翻。
- Android 8（API 26）矩阵未跑；若 API 26 上连软件 X25519 都不可用，回退本 ADR。
