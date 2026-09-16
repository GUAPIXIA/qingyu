# Cross-platform baseline fixtures（阶段 0）

> 来源：全部为**人工合成**去隐私样本。  
> 禁止：真实 API Key、Token、私聊正文、真实头像二进制。  
> 用途：TS/Kotlin 一致性测试与迁移/同步契约 golden。  
> 修订：`fixtureRevision` 见根目录 `manifest.json`。

## 目录

| 目录 | 覆盖 |
|---|---|
| `characters/` | 角色卡 V1/V2/V3、内嵌世界书、头像占位 |
| `sessions/single-chat/` | 单聊 1 / 100 条（分支、swipe、编辑、删除）；`sessions/messages-10k.jsonl` 为生成式 10k 基线（由脚本再生，避免巨大 git 膨胀时见 notes） |
| `sessions/group-chat/` | 群聊三种模式与发言顺序 |
| `lorebooks/` | 各导入形态、关键词/正则/语义、未知字段 |
| `presets-personas-quickreplies-regex/` | 预设、人设、快捷回复、正则 |
| `memory/` | 记忆摘要、事实、向量缺失降级 |
| `unicode-markdown/` | 中文、emoji、组合字符、长文本、Markdown、`<thought>` |
| `corruption/` | 损坏文件、未知 schema、重复 ID、孤儿外键 |

## 密钥扫描

合入前对本树运行高熵/PEM/api_key 模式扫描；结果写入阶段 0 报告。
