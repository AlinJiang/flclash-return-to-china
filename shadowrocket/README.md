# iPhone：Shadowrocket

iOS 没有 FlClash，Shadowrocket 也不能运行 `override.js`。这里的 `return-to-china.conf` 由 `tools/build-shadowrocket.mjs` 从 `override.js` 生成：同一套分流规则、同样的顺序，规则集换成同一批列表的 Surge 格式版本。Sukka 自己发布 Surge 格式；v2fly 的列表 meta-rules-dat 只有 Clash 格式（`+.域名`），Shadowrocket 读不懂，所以由 GitHub Actions 每天转换一次，发布在本仓库的 `shadowrocket-lists` 分支上（`tools/build-shadowrocket-lists.mjs`）。节点来自 Shadowrocket 里你自己添加的订阅，这份配置不含任何机密。

在家连 Wi-Fi 时旁路由已经在分流，Shadowrocket 可以关掉；出门用流量时再打开。

## 设置

1. **添加订阅**：EdNovas 后台 → 仪表盘 → "Shadowrocket 订阅"，复制链接（在手机上复制，不要经聊天软件转发）。Shadowrocket → 首页右上角 `+` → 类型选 Subscribe，粘贴链接，保存。
2. **添加配置**：Shadowrocket → 配置 → 右上角 `+`，粘贴

   ```text
   https://raw.githubusercontent.com/AlinJiang/flclash-return-to-china/main/shadowrocket/return-to-china.conf
   ```

   下载后点这份配置 → 使用配置。
3. **自动更新**：
   - Shadowrocket → 设置 → 自动更新：配置的自动后台更新打开，间隔 1 天；订阅的自动后台更新打开，间隔按需（例如 6 小时）。
   - iOS 设置 → 通用 → 后台 App 刷新，打开 Shadowrocket。手动划掉 App 或重启手机后，后台更新要等下次打开 App 才恢复。
4. 首页"全局路由"选**配置**。

想立刻用上新规则：配置 → 点这份配置 → 使用配置，会重新下载所有规则集。

## 装好后核对

配置 → 测试规则，逐个输入：

| 域名 | 应该命中 |
|---|---|
| `api.bilibili.com` | `回国或直连` |
| `www.bilibili.tv` | `DIRECT`（B 站海外版） |
| `vd.l.qq.com` | `回国或直连`（腾讯视频播放信息，被去广告误拦，提前放行） |
| `amdc.m.taobao.com` | `REJECT` |
| `www.google.com` | `DIRECT` |

再看首页的代理分组：`回国节点` 里应该只有 🇨🇳 节点。

`api.bilibili.com` 落到 `FINAL` 的话，说明 v2fly 的列表没下载到：配置 → 编辑配置 → 规则集 URL 里看哪几个是 ❎。

## 和 FlClash、旁路由的差别

- **更新频率**：配置和规则集最快每天更新一次，FlClash 和旁路由上我们的规则每小时、上游列表每天。v2fly 列表本身先经 `shadowrocket-lists` 分支转换一次，那里每天 UTC 04:47 更新。
- **放行例外**：Shadowrocket 不能让 `unblock.txt` 的域名"跳过"去广告规则继续往下匹配，所以这些行放在最前面，直接去 `return.txt` 或 `DIRECT` 会送它们去的地方。
- **QUIC**：规则里不能嵌套规则集，没有"节点不支持 UDP 时拒绝回国 QUIC"那条保护。EdNovas 的节点都支持 UDP，影响不大。
- **兜底顺序**：`回国或直连` 依次是 `回国节点`、`回国备用`（第一个通过检测的节点）、`DIRECT`，不像 FlClash 那样逐个节点列出，所以当前节点刚好出问题时，偶尔会短暂直连。
- 这份配置没法在 CI 里用 Shadowrocket 实测，CI 只检查它和 `override.js` 一致、每个规则集都能下载。
