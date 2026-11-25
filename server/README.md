# GUN TO GUN · 好友 5v5 房间服务

Cloudflare Workers + Durable Objects（一房一 DO）。DO 只做**房间注册表 / 消息扇出 / 权威记分板**；不跑 three.js、不跑物理、不跑 AI。三个离线模式完全不连接本服务。

## 本地运行

```bash
npm run server:dev          # wrangler dev --local --config server/wrangler.toml
# 另开两个浏览器窗口：
# http://127.0.0.1:8137/?server=ws://127.0.0.1:8787
# 一人 CREATE ROOM，另一人输入 5 位房号 JOIN，双方 READY → 房主 START
```

`wrangler` 不在 `package.json` 依赖里，由 `npx` 按需拉取，避免增大游戏构建体积。

## 部署与正式构建

```bash
npm run server:deploy
GTG_SERVER=wss://<你的worker>.workers.dev npm run build
```

服务器地址优先级：`?server=` → `localStorage.o07_server` → 构建常量 `__GTG_SERVER__` → 空（提示未配置）。
GitHub Pages 是 HTTPS，只能连 `wss://`；`ws://` 仅限本地开发（混合内容限制）。

## 协议与权威边界

- 位置 / 移动：各客户端自己的；15 Hz 上行 `c:snap`，12–15 Hz 下行 `s:peers`（约 100 ms 插值延迟）。
- 机器人：仅房主模拟，12 Hz `c:botSnap` 快照复制；房主掉线时 DO 选举新房主并接管。
- 伤害：攻击方本地射线判定 → DO 钳制上限并转发 `s:hit` → 被击方在自己的 `damagePlayer()` 内结算。
- 击杀 / 死亡 / 计时 / 胜负 / 名册：**DO 权威**，1 Hz `s:tick`，结束广播 `s:end`。
- 联机**不写** `o07_best`、**不提交**排行榜，不污染离线进度。

消息上限：单连接 32 msg/s + 4 KB/帧（令牌桶）；房间 300 msg/s。无效帧静默丢弃；名册名去重；房间码 5 位（去掉 0/O/1/I）。

## 免费额度估算（2025 方案，实际以 Cloudflare 官网为准）

Workers Free：每天 10 万请求；Durable Objects Free：每天 10 万次 WS 消息计费单元（含 hibernation 后的按消息计费）。
10 人房 15 Hz 上行 ≈ 150 msg/s，1 局 3 分钟 ≈ 2.7 万消息；免费额度足以支撑数局/天的小型好友局。

## 信任模型

房间码制，**无公开匹配、无排位**。位置与伤害由客户端上报，DO 只做有限钳制；房主模拟机器人，因此房主在本地有作弊空间。适合互相信任的朋友之间娱乐，不适合竞技场景。
