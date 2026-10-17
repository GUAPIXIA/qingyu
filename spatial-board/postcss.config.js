/** 空间画板不需要 PostCSS 插件（`src/styles.css` 为纯 CSS，无 @tailwind 指令）。
 *
 * ⚠️ 本文件必须存在：否则 Vite 会沿目录向上找到**仓库根**的 `postcss.config.js`
 * （其中 require tailwindcss / autoprefixer），而 `spatial-board` 没有这两个依赖，
 * 且 CI 只安装本目录的 node_modules —— 结果是 `src/styles.css` 返回 500、页面无法渲染，
 * 浏览器回归卡在 `.react-flow__pane` 不可见（2026-10-17 由 CI 诊断工件定位）。
 */
export default { plugins: {} }
