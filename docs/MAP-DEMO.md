# 四地图穿模验收 Demo

打开项目根目录的 **`map-demo.html`** 即可。它是完全自包含的单文件（Three.js、程序化贴图、四张地图均已打包），双击即可从 `file://` 运行，无需启动服务器、不请求网络资源、不进入 FPS 战斗。

## 操作

- `1–4`：切换 desert / snow / snowtown / ember
- `T`：正俯视；`P`：透视
- `C`：collider 线框（青色地面、紫色 overhead）
- `M`：本轮修复点标记
- `F`：开关地图雾效
- 空格：每 10 秒自动巡览
- 左键拖动旋转，滚轮缩放，右键拖动平移

右侧面板显示当前地图的 collider / LOS statics 数量与 >2 cm AABB 冲突数。检查模式下雾效默认关闭，并按地图调整曝光以便肉眼验收；这些显示设置不修改游戏源码或实际玩法光照。

## 重新生成

```bash
npm run build:map-demo
```

源文件：

- `tools/map-demo/main.js`
- `tools/map-demo/style.css`
- `tools/map-demo/template.html`
- `scripts/build-map-demo.mjs`
