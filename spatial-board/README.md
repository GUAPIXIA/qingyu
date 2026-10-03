# 空间画板独立包

Windows 下可在项目根目录双击 `启动空间画板.bat`。脚本会在首次启动时安装依赖，随后启动画板并打开 `http://localhost:5188/`。保持命令窗口开启即可使用画板。

也可在此目录运行 `npm install` 和 `npm run dev` 手动启动。

- `npm test`：边界、Schema、单元测试和 TypeScript 检查。
- `npm run test:browser`：在真实 Chromium 浏览器中检查区域绘制、侧栏视口、角色拖放和刷新恢复。先尝试 Playwright 自带 Chromium，未安装时使用本机 Chrome；无浏览器时运行 `npx playwright install chromium`。
- `npm run build`：独立生产构建。

浏览器测试使用端口 5197，并为每次运行创建全新的浏览器上下文。失败截图写入 `output/playwright/spatial-browser-failure.png`。
画板目录改动也会触发独立的 GitHub Actions 工作流，执行上述测试与构建。
