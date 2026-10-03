# invalid fixtures

每个文件是一份**应当被拒绝**的样本。拒绝层级分两类：

| 文件 | 拒绝层 | 说明 |
|---|---|---|
| `missing-required.json` | JSON Schema | 节点缺 `name` / `regionCategory` |
| `geometry-non-positive.json` | JSON Schema | 区域宽高不是正数 |
| `distance-measurement.json` | JSON Schema | `custom` 单位缺 `customUnit`；`value=null` 且 `displayText` 空 |
| `third-node-kind.json` | JSON Schema | `kind=door`（第三种空间图形） |
| `cross-kind-distance.json` | 领域校验（阶段 1） | region ↔ place 距离 |
| `cross-board-distance.json` | 领域校验（阶段 1） | 距离两端跨画板 |
| `circular-parent.json` | 领域校验（阶段 1） | 父子循环 |
| `dangling-child-board.json` | 领域校验（阶段 1） | `childBoardId` 悬空 |

阶段 0 的 `test:schema` 只断言 **JSON Schema 层** 反例必须失败、正例必须通过。
领域反例保留给阶段 1 的 hierarchy / distance / placement 校验器。
