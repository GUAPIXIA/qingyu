# Golden Fixtures（V12-01-2）

> 目标：冻结桌面与 Bridge 在 `0.11.28` 旧引擎下的行为，作为 `0.12` `ChatOrchestrator` 的回归基线。  
> 原理：固定 `输入 + 上下文快照 + 模型假响应 -> 预期 assistant 消息`，新旧引擎对同一 fixture 产出一致即通过。

## 目录约定

```
tests/golden/chat/
├── fixtures/
│   ├── input-regex/           # 5 组
│   ├── output-regex/          # 5 组
│   ├── stop-strings/          # 5 组
│   ├── lorebook-keyword/      # 5 组
│   ├── semantic-lore/         # 3 组
│   ├── semantic-facts/        # 2 组
│   ├── vision/                # 2 组
│   ├── swipe-regenerate/      # 3 组
│   ├── continue/              # 2 组
│   └── memory-title/          # 2 组
├── snapshots/                 # vitest 快照（预期消息，已提交）
├── goldenRunner.ts            # 通用运行器：fixture -> 旧/新引擎 -> 断言
└── README.md
```

## Fixture 格式

```json
{
  "id": "input-regex-01",
  "description": "input 正则：粗体标记清理",
  "input": { "content": "你好 **世界**", "images": [] },
  "contextSnapshot": {
    "characterId": "char-1",
    "sessionId": "sess-1",
    "presetId": "preset-1",
    "settings": { "userName": "用户" },
    "regexRules": [{ "pattern": "\\*\\*", "replacement": "", "scope": "input", "stage": "text" }]
  },
  "modelResponses": [
    { "delta": "你好", "usage": null },
    { "delta": " 世界", "usage": { "promptTokens": 10, "completionTokens": 5 } }
  ],
  "expected": {
    "userMessage": { "content": "你好 世界" },
    "assistantMessage": { "content": "你好 世界" }
  }
}
```

## 运行

```bash
pnpm test -- tests/golden/chat
```

`goldenRunner.ts` 遍历 `fixtures/**/*.json`，用 `FakeModelPort`（V12-06 前用旧引擎直跑）比对 `expected`，不通过即快照失败。

## 约束

* 新增能力必须先加 fixture，再改引擎。
* `expected` 由 `0.11.28` 旧引擎跑一次后 `--update` 快照锁定，后续 `0.12` 不得擅自改快照。
