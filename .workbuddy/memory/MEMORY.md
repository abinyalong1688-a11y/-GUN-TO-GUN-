# GUN TO GUN 项目长期笔记

## 构建与部署
- `npm run build` → `dist/`（页面约 1.2 MB + `assets/characters/*.glb` 模型文件）；部署上传整个 `dist/`。
- `npm run build:single` → `dist-single/`，模型内嵌，可双击打开。
- 人物只有一男一女两个 GLB；改干员外观后跑 `npm run bake:portraits` 重烘缩略图。
- 无离线模式（SW 已移除）。联机房间服务在 `server/`，改 `src/netProtocol.js` 后需重新部署 Worker。

## 约定
- 用户要求：改代码前先确认；未经要求不 commit / push；用大白话解释。
- `?botai=0` 关闭小队 AI；`?debug=1` 暴露 `__GTG_DEBUG__` / `__squadAI`。
- 测试：`npm test`（单元）、`npm run test:e2e`（无头浏览器）、`npm run test:load`（慢网加载）。
- e2e 里自推进模拟的用例要设 `this._e2eHold` 并定期 `await breathe()`。

## 已知待办
- 首帧着色器编译约 3–4 秒（真实 GPU），期间菜单尚未绘制；可考虑 `renderer.compileAsync`。
- `share-card` e2e 用例单次阻塞约 13 秒，机器繁忙时可能触发 CDP 30 秒超时。
