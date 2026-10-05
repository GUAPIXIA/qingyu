# tools/pc-agent/probes/ — 阶段 0 可行性探针

> 用途：在建设 CLI/MCP 运行器之前，用最小脚本实测“外部驱动能不能操作现有应用、怎么隔离、怎么识别窗口”。
> 证据输出：`output/pc-agent/phase0/<label>-<时间戳>/`（`result.json`、`report.md`、`screenshots/`）。
> 结论汇总：[阶段 0 实施报告](../../../docs/报告/PC端外部Agent工具阶段0实施报告-2026-10-03.md)。

## 1. 探针清单

| 脚本 | 目标 | 实测结果 |
|---|---|---|
| `launch-source-dev.mjs` | 源码模式：两种隔离方式（launcher `setPath` / 原生 `--user-data-dir`）驱动现有应用 | ✅ 通过：主窗口识别、`window.api` 28 命名空间、只读调用、正式数据未被触碰 |
| `launch-packaged-cdp.mjs` | 打包/安装版：`--user-data-dir` + `--remote-debugging-port` + CDP 连接 | ✅ 通过：加载发布产物、CDP 可用、隔离生效、构建陈旧可检出 |

```powershell
node tools/pc-agent/probes/launch-source-dev.mjs      # 需要能起 5173 端口
node tools/pc-agent/probes/launch-packaged-cdp.mjs    # 需要 release-v2/win-unpacked 打包产物
```

退出码 0 = 全部检查通过；非 0 = 有检查未通过，`result.json` 内含逐项结果。

## 2. 实测得到的三条硬约束

1. **必须先清除 `ELECTRON_RUN_AS_NODE`。** 本机（DSH 宿主跑在 Electron 上）该变量为 `1`，不清除时 `electron.exe` 退化为纯 Node，Playwright 报 `Process failed to launch!`。`electronEnv()` 负责清理，`scripts/lib/electronHarness.mjs` 出于同一原因也删除它。
2. **源码模式拿不到发布产物。** `electron/main.ts` 用 `isDev = !app.isPackaged` 分流：源码启动走 `loadURL('http://localhost:5173')`，源码模式的渲染层必然是 dev bundle。要验证发布产物，必须运行打包/安装版。
3. **`app.getVersion()` 不能当构建身份。** 注入 launcher 时它返回 Electron 版本（实测 `43.4.0`）、`getAppPath()` 落在 run 目录。构建身份要从产物本身采集（包内版本、`dist`/`dist-electron` 或 asar 的 mtime 与哈希、git commit）。

## 3. 窗口识别结论

dev 模式会额外开一个 detached DevTools 窗口。实测两个窗口：

| URL | `window.api` | 判定 |
|---|---|---|
| `http://localhost:5173/` | `object` | 真实主窗口 |
| `devtools://devtools/bundled/devtools_app.html?…` | `undefined` | DevTools，排除 |

综合判据：**URL（dev server 或 `file://…/dist/index.html`）+ `window.api` 可用性**，不能依赖 `firstWindow()` 或窗口顺序（两次探针中的枚举顺序并不一致）。

## 4. 安全约定（探针自身遵守）

- 只启动**隔离**实例：`userData` 必须在 run 目录下；打包探针在继续操作前先确认隔离目录已被写入（安全闸门），否则立即终止。
- 不接管用户已打开的正式客户端；不修改安装包；不写正式数据目录。
- 每次运行前后对 `%APPDATA%\轻语`、`%APPDATA%\qingyu` 取指纹（mtime／条目数／文件数），结果写进 `result.json` 的 `productionUserData`。

## 5. 依赖说明

探针临时复用 `spatial-board` 安装中的 Playwright（`probe-common.mjs` 的 `loadPlaywright()`），仅为验证可行性，**不是长期依赖**。工具包自持依赖从阶段 1 开始（见 [../README.md](../README.md) §5）。
