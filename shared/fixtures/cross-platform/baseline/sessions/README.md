# sessions/

| 文件 | 说明 |
|---|---|
| `single-chat/session-1-message.json` | 单聊 1 条 |
| `single-chat/session-100-skeleton.json` | 100 条会话骨架：分支/swipe/编辑/逻辑删除 |
| `single-chat/messages-10k.jsonl` | 确定性生成的 10k 消息基线（见生成说明） |
| `group-chat/group-modes.json` | natural / nomination / poll 三模式 |

来源：人工合成。

## 10k 消息生成

使用固定种子在测试或脚本中生成，避免手工维护百万级行；完整 10k 文件由 `pnpm exec tsx scripts/gen-phase0-messages-10k.ts`（或等价 vitest 夹具）写出到本目录时才会提交大文件。阶段 0 默认提交骨架 + 生成器约定，运行时扫描性能用内存生成集测量。
