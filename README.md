# FlClash 回国分流

在海外使用回国机场时，按需回国：

- 只有必须用中国大陆 IP 的服务走回国节点：影音版权、淘宝天猫、政务、银行、运营商。
- 其余流量全部本地直连，包括微信、支付宝、百度、京东这些海外本来就能正常用的国内服务。
- 拦截广告。

多台 FlClash 设备共用 GitHub 上同一份 `override.js`。机场订阅和凭据只留在各自设备上，仓库里没有任何机场 URL、token 或节点信息。

适用版本：FlClash 0.9.1。它内置的核心是 [chen08209/Clash.Meta@8380d0e](https://github.com/chen08209/Clash.Meta/tree/8380d0e7462f061a964323e9bf3129a236fcc5d5)，本文的行为结论都对照这一版源码。FlClash 界面里的“配置”就是 Profile。

## 日常怎么用

代理页面只有一个组：**`回国节点`**。

- **默认**：自动选延迟最低的回国节点。
- **机场挂了**：所有回国节点都不通时，必须回国的服务在一两分钟内自动改走直连，App 照样能用，只有版权受限的内容会提示地区限制；节点恢复后自动切回，不用手动处理。
- **需要稳定时**：点某个节点把它固定住。它挂了，核心自动换到最快的可用节点，恢复后再用回它；再点一次取消固定。（[核心](https://github.com/chen08209/Clash.Meta/blob/8380d0e7462f061a964323e9bf3129a236fcc5d5/adapter/outboundgroup/urltest.go#L103-L116)、[FlClash](https://github.com/chen08209/FlClash/blob/8d4f9744948751f1273fe871e1d05276fac09b0e/lib/views/proxies/card.dart#L10-L31)）

应急直接用 FlClash 首页的“出站模式”：

| 出站模式 | 什么时候用 | 效果 |
| --- | --- | --- |
| 规则 | 平时 | 必须回国的走 `回国节点`，其余直连 |
| 全局 | 规则漏了某个服务、某个 App 必须用中国 IP（比如支付宝人脸验证） | 所有流量都走 `回国节点`。脚本让 `GLOBAL` 默认就选 `回国节点`，切过去就生效 |
| 直连 | 回国机场时好时坏，自动切换来回跳的时候 | 所有流量直连 |

- 切换出站模式不会断开已有连接。App 没反应时，到“连接”页关掉它的旧连接，或者重开 App。
- 系统代理模式下，FlClash 默认的“排除域名”里有 `*jd.com`、`*360buyimg.com`、`*zhihu.com`、`*zhimg.com`（[源码](https://github.com/chen08209/FlClash/blob/8d4f9744948751f1273fe871e1d05276fac09b0e/lib/models/config.dart#L13-L31)）。这些网站不经过 FlClash，全局模式也管不到。需要它们回国时，删掉这几项，或改用虚拟网卡模式。
- 全局模式解决问题后，把那个服务加进 `rules/return.txt`（见下文），再切回“规则”。

## 家里的旁路由

家里的电视、游戏机和没装 FlClash 的设备，可以通过 NAS 上的旁路由使用同一套分流，见 [`router/README.md`](router/README.md)。它的配置 `router/config.yaml` 由 `override.js` 生成，规则和 FlClash 设备完全一样。

## 名单从哪里来

名单几乎全部来自社区持续维护的规则集，由每台设备上的核心自动下载和更新：

| 来源 | 用途 | 更新 |
| --- | --- | --- |
| [v2fly/domain-list-community](https://github.com/v2fly/domain-list-community)，经 [MetaCubeX/meta-rules-dat](https://github.com/MetaCubeX/meta-rules-dat) 每日构建 | 各平台、银行、运营商的域名；`@!cn` 海外版；`@ads` 广告和统计；`bilibili-cdn` | 核心每天检查 |
| [SukkaW/Surge](https://github.com/SukkaW/Surge)（ruleset.skk.moe） | 去广告；海外也能直连的 CDN（`domestic_cdn`）；网易云 | 核心每 12 小时检查 |
| 本仓库 `rules/` 下三个文件 | 社区没有的少数服务、被去广告误拦的域名，以及你的个人调整 | 核心每小时检查 |

社区没有以“必须中国 IP 才能用”为标准的回国名单：要么是“所有中国域名”（太宽），要么是分平台列表。所以脚本只决定启用哪些分平台列表、按什么顺序。

没有用 MetaCubeX 构建的 `category-bank-cn` 等汇总分类作主名单：它的构建器不支持 v2fly 新增的过滤 include 语法，汇总分类会漏掉大项（[domain-list-custom#135](https://github.com/Loyalsoldier/domain-list-custom/issues/135)、[meta-rules-dat#180](https://github.com/MetaCubeX/meta-rules-dat/issues/180)），例如缺工行、中行、建行、招行、中信。这五家和平安用各自的独立列表补上。v2fly 完全没有的交行网银（`95559.com.cn`）、农行 `abchina.com.cn` 网银、平安企业网银（`orangebank.com.cn`）、浙商、恒丰、渤海写在 `rules/return.txt`；城商行、农商行没有逐一覆盖。

## 分流规则

从上到下匹配，第一条命中的规则生效：

| 顺序 | 规则 | 出口 | 来源 |
| --- | --- | --- | --- |
| 1 | 广告 | 拒绝 | Sukka reject 系列；v2fly 爱奇艺、优酷、芒果、腾讯音乐、CCTV 的 `@ads`。`rules/unblock.txt` 里的域名不拦 |
| 2 | `rules/direct.txt` | 直连 | 本仓库：WeType、微信视频号和朋友圈视频、v2fly 没标海外版的银行和运营商海外公司 |
| 3 | `rules/return.txt` | 回国节点 | 本仓库：腾讯视频、网易云的 163jiasu 接口别名、淘宝天猫、政务、v2fly 缺的银行域名 |
| 4 | 发往 3 的 QUIC，而当前节点不支持 UDP | 拒绝 | 见下文“UDP 和 QUIC” |
| 5 | 各平台海外版、银行和运营商的海外公司 | 直连 | v2fly `xxx@!cn`（B 站国际版、iQ.com、优酷国际版、工行海外分行、中银香港、平安香港等） |
| 6 | 海外也能直连的 CDN | 直连 | Sukka `domestic_cdn`（B 站图片、网易云音频、淘宝静态资源等）；v2fly `bilibili-cdn`（B 站视频） |
| 7 | 影音 | 回国节点 | v2fly `bilibili`、`iqiyi`、`youku`、`hunantv`（芒果）、`cctv`、`tencent-tme`（QQ 音乐、酷狗、酷我、喜马拉雅）；Sukka `neteasemusic` |
| 8 | 银行、运营商（含咪咕） | 回国节点 | v2fly 工行、中行、建行、招行、中信、平安、银联、`category-bank-cn`（其他银行）；移动、电信、联通 |
| 9 | 网易云直接按 IP 调用的接口 | 回国节点 | Sukka `ip/neteasemusic` |
| 10 | 发往 7 到 9 的 QUIC，而当前节点不支持 UDP | 拒绝 | 同上 |
| 11 | 其余全部，包括海外能正常用的国内服务 | 直连 | |

- **尽量只让接口回国。** 实测从海外访问时，B 站番剧的区域限制在播放接口，网易云的版权判断在 `music.163.com` 接口；两者的音视频 CDN 都能直接给海外 IP 提供内容。QQ 音乐和 CCTV 同样在接口上判断。BiliRoaming、UnblockNeteaseMusic 这些解锁工具也只代理接口。各平台的音视频实际这样走：
  - B 站、网易云、QQ 音乐、优酷、腾讯视频：接口回国，音视频 CDN 直连。QQ 音乐的音频文件 `music-file*.y.qq.com` 在 v2fly 的 `y.qq.com` 下面，由 `direct.txt` 拿出来直连。
  - 爱奇艺、芒果：v2fly 里是整平台一个列表，视频流也走回国。
  - CCTV：网页和接口回国；直播流在第三方 CDN 上，直连。
- **不做 DNS 解析。** 每条规则集规则都带 `no-resolve`，分流不依赖 DNS 应答。规则集里的 IP 规则只匹配直接按 IP 发起的连接。
- **不用 `GEOSITE` / `GEOIP`。** 全部用规则集，不加载整份 GeoSite 数据。
- **规则集数量。** 共 45 个。除了 Sukka 的广告域名集（约 14 万条，3 MB 多）以外都只有几 KB。首次启动会全部下载一次。某个规则集下载完成前，对应规则为空，流量落到下一条命中的规则：回国名单为空时相应流量暂时直连，海外版和 CDN 这些直连例外为空时，相应流量暂时走回国。

## 回国节点组

- 类型是 `url-test`，60 秒检测一遍全部节点，延迟差 300 ms 以内不切换，只在被用到时检测（`lazy`）。300 ms 是按一天的 EdNovas 检测数据定的：门槛 50 ms 时一天约换 18 次节点，300 ms 时约 10 次，多出来的平均延迟只有 14 ms。每次换节点都会换出口 IP，而这点延迟差对接口和听歌没有影响。
- 健康检查用 `http://wifi.vivo.com.cn/generate_204`，要求返回 204。回国节点从中国大陆出口，用境外检测地址测到的是再次出境的链路；返回 204 以外的状态（劫持页、登录页）都算失败。用 HTTP 是因为每次检测都算回国流量（EdNovas 按 5 倍计），HTTPS 的握手一次约 7 KB，HTTP 约 0.4 KB。
- 成员是机场的全部节点，去掉公告和流量节点（“剩余流量”“到期”“官网”“群”等），去掉 `direct`、`dns` 这类不转发的节点。provider 里的节点在运行时用 `exclude-filter`、`exclude-type` 去掉（[源码](https://github.com/chen08209/Clash.Meta/blob/8380d0e7462f061a964323e9bf3129a236fcc5d5/adapter/outboundgroup/groupbase.go#L200-L228)）。
- 机场同时卖出国和回国节点时，只用名字里带 `🇨🇳`、`回国`、`大陆` 或 `内地` 的节点（例如 `🇨🇳 北京`、`上海 香港中转 🇨🇳`、`港广专线_回国`）。一个都没有时，全部节点都算回国节点，适用于名字里看不出方向的纯回国机场。只对内联节点生效；provider 里的节点在脚本运行时还不知道名字，混合机场的 provider 要在旁路由配置里单独加 `filter`。
- **前提：用到的节点都从中国大陆出口。** 名字里没有这些标记、又混着香港或日本节点的机场不适用。名字里的 `香港` 不算出境标记：`上海 香港中转` 是从上海出口。
- 链式代理的前置跳板（节点 `dialer-proxy` 指向的节点或组）不进组：跳板组列出的节点、它 `use` 的 provider 都按跳板处理。provider 自己或它的 `override` 带 `dialer-proxy` 时，它的节点全部是出口。脚本不计算跳板组的 `filter`；跳板组用 `include-all-proxies` 时所有内联节点都按跳板处理，若因此一个出口都不剩，就把全部节点放回来。这时组里可能混进中转节点，用 `tools/check-profile.mjs` 可以看核心实际给出的成员。
- 订阅过期、只剩公告节点时，组里只剩 `DIRECT`，必须回国的服务暂时直连。
- 规则实际指向隐藏的 `回国或直连`（`fallback` 类型），成员依次是 `回国节点`、每一个回国节点，最后是 `DIRECT`。它用第一个通过最近一次检测的成员：平时是 `回国节点`（最快的节点）；`回国节点` 正在用的节点没通过检测时，用下一个通过的节点；所有节点都没通过时才用 `DIRECT`。`fallback` 检测一个组时，走的是那个组当前用的节点，所以只放 `回国节点` 和 `DIRECT` 的话，一个节点偶尔超时就会把全部回国流量甩到直连（2026-10-22 的 EdNovas 数据：单次检测失败率约 3%，其中 84% 是只出现一次的偶发失败，一天里没有一次 14 个节点同时失败）。
- 组里直接写的成员排在订阅源（provider）的节点前面（[源码](https://github.com/MetaCubeX/mihomo/blob/v1.19.32/adapter/outboundgroup/parser.go)），所以机场节点来自 provider 时，`DIRECT` 由脚本加的一个只含直连出口的 `inline` provider（`回国直连`）提供，排在机场 provider 后面。这个组的 `exclude-type` 不排除 `Direct`；机场 provider 里如果混有 `direct` 类型的节点，会在它前面被选中。
- 两个组都是 60 秒检测一次，检测超时用默认的 5 秒：一天里成功的检测最慢 2.1 秒。provider 里的节点按 provider 自己的健康检查检测；它没开健康检查时，按第一个登记它的组的间隔（[源码](https://github.com/MetaCubeX/mihomo/blob/v1.19.32/adapter/provider/healthcheck.go)），机场自己的组可能先登记、间隔更长。旁路由给订阅源配了自己的 60 秒健康检查，不受这个影响。内联节点会被两个组各测一次，结果共用。
- 机场的组用了 `include-all` 或 `include-all-providers` 时，Mihomo 会把所有 provider 都给它，包括 `回国直连`。脚本把这些组改成按同样顺序列出机场自己的 provider，免得 DNS、链式代理经过的机场组也拿到直连。启动时和连续几次连接失败时会立刻检查，使用中每 60 秒检查一次，节点恢复后自动切回（[源码](https://github.com/chen08209/Clash.Meta/blob/8380d0e7462f061a964323e9bf3129a236fcc5d5/adapter/outboundgroup/fallback.go)）。检测地址从海外直连也能访问，所以 `DIRECT` 总是可用的退路。它在代理页面和 FlClash 的规则模式下都不显示。
- 机场原有的组全部保留但隐藏：节点的 `dialer-proxy`、`tunnels`、DNS 的 `#组名` 可能引用它们，缺失会让核心拒绝整份配置（[源码](https://github.com/chen08209/Clash.Meta/blob/8380d0e7462f061a964323e9bf3129a236fcc5d5/config/utils.go#L148-L176)）。DNS 和 sniffer 引用的机场规则集也会保留。
- 机场已有同名的节点或组时，脚本的组自动加后缀，例如 `回国节点 2`。机场配置自带 select 类型的 `GLOBAL` 时，脚本不另建，而是把 `回国节点` 放进它的第一位。

## UDP 和 QUIC

节点不支持 UDP 时（例如没有 `udp: true` 的 SSR 节点），Mihomo 会跳过指向它的规则，继续往下匹配（[源码](https://github.com/chen08209/Clash.Meta/blob/8380d0e7462f061a964323e9bf3129a236fcc5d5/tunnel/tunnel.go#L685-L688)）。所以每段回国规则之后、任何直连规则之前，都有一条规则拒绝发往这些目标的 QUIC（第 4、10 条）。浏览器和 App 会改用 TCP 走回国，而不会掉到后面的直连。

当前节点支持 UDP 时，QUIC 和其他 UDP 都正常走回国。节点不支持 UDP 时，非 443 端口的 UDP（例如语音通话）仍会直连，通话可以继续工作。

## 去广告

- **Sukka 是主力**：基础域名集约 14 万条，外加关键词规则，每天构建两次，有白名单避免误杀。它还会拦截 App 自带的 HTTPDNS（例如淘宝的 `amdc.m.taobao.com`），迫使 App 改用系统 DNS，回国名单才能按域名匹配到它们。
- **去广告排在所有规则之前**，包括本仓库的 `direct.txt` 和 `return.txt`：`return.txt` 里的 `taobao.com` 不会把 Sukka 拦截的淘宝广告、统计和 HTTPDNS 一起放行送去回国。Sukka 没收录、只在 v2fly `alibaba@ads` 里的少数淘宝统计域名仍随淘宝回国：没有引用 `alibaba@ads`，因为它还包含第三方 App 调起淘宝时用的百川 SDK 等域名，拦掉可能影响登录和跳转。
- **v2fly 只补影音平台的 `@ads`**，免得这些广告和统计域名混在平台列表里跟着走回国。
- **路由器上的去广告 DNS 对 FlClash 设备基本不起作用**：FlClash 运行时，直连流量的域名由核心用机场 DNS 解析；虚拟网卡模式下，设备的 DNS 查询会被 FlClash 接管。它适合给电视等不跑 FlClash 的设备用。

## 每台设备的设置

1. 正常导入机场订阅，保持它的自动更新。
2. 打开“工具 → 进阶配置 → 脚本”，点“添加 → 通过URL导入”，URL 为 `https://raw.githubusercontent.com/AlinJiang/flclash-return-to-china/main/override.js`。
3. 在“配置”页面打开机场配置的菜单，选“扩展”。扩展模式选“脚本”，再在“扩展脚本”里选中刚添加的脚本。
4. 出站模式设为“规则”。FlClash 会用自己的模式、端口、`unified-delay`、`find-process-mode` 等设置覆盖配置（[源码](https://github.com/chen08209/FlClash/blob/8d4f9744948751f1273fe871e1d05276fac09b0e/lib/common/task.dart#L161-L231)）。
5. 检查：代理页面应只显示 `回国节点`；机场配置菜单的“更多 → 运行时配置”应能看到规则。
6. 打开“资源”页面的“自动更新”：FlClash 每 20 分钟检查一次，按“自动更新间隔”（默认 24 小时）更新脚本（[源码](https://github.com/chen08209/FlClash/blob/8d4f9744948751f1273fe871e1d05276fac09b0e/lib/providers/actions/resources.dart#L103-L122)）。不打开时，在脚本菜单里点“同步”。`rules/` 文件和社区列表的更新不受这个开关影响，核心自己会更新。

## 调整规则

日常调整只改三个文本文件，每行一条 Mihomo 规则，不写目标：

```text
# rules/return.txt：走回国节点
DOMAIN-SUFFIX,example.cn

# rules/direct.txt：直连，用来把回国名单里不需要中国 IP 的部分拿出来
DOMAIN,wetype.weixin.qq.com

# rules/unblock.txt：被去广告误拦的域名，放行后按其余规则分流
DOMAIN,vd6.l.qq.com
```

- 支持 `DOMAIN`、`DOMAIN-SUFFIX`、`DOMAIN-KEYWORD`、`DOMAIN-WILDCARD`、`IP-CIDR`、`IP-CIDR6`。
- `direct.txt`、`return.txt` 排在去广告之后、所有社区名单之前，`direct.txt` 又在 `return.txt` 之前。它们不会放行广告；放行误拦的域名用 `unblock.txt`，尽量写完整域名。
- 开 PR，CI 通过后合并进 `main`，所有设备最多约 1 小时（加上 GitHub 5 分钟缓存）自动生效，不需要同步脚本。
- 写错的行只会被跳过，不会让配置失效；CI 也会检查格式。

`override.js` 顶部的 `SETTINGS` 很少需要改：

- `ownRulesBase`：三个规则文件的地址。GitHub 用户名或仓库名与 `AlinJiang/flclash-return-to-china` 不同时要改。
- `blockAds`：关闭去广告。会同时失去对 HTTPDNS 的拦截。
- `mediaCdnViaReturn`：改成 `true` 后去掉第 6 条，B 站视频和网易云音频随平台名单走回国，适用于这两个平台“只走接口”时播放失败。

## 发布流程

脚本更新时，FlClash 会直接覆盖本地旧脚本，不做任何检查（[源码](https://github.com/chen08209/FlClash/blob/8d4f9744948751f1273fe871e1d05276fac09b0e/lib/models/common.dart#L738-L750)）。所以：

- 所有设备直接读 `main`，所以 `main` 受保护：只能通过 PR 合并，CI 通过才能合并，禁止 force push 和删除。一次坏提交会在一小时到一天内扩散到每台设备，CI 在合并前拦住它。
- 改了 `override.js` 就提高 `SCRIPT_VERSION`。
- 仓库必须公开：FlClash 下载脚本、核心下载 `rules/` 文件都不带认证。仓库里没有任何机场信息。

CI（`.github/workflows/test.yml`）在每个 PR、每次合并和每天定时运行：

- 语法；Node 与 QuickJS-ng 按 FlClash 的严格模式执行，输出完全一致（[源码](https://github.com/chen08209/FlClash/blob/8d4f9744948751f1273fe871e1d05276fac09b0e/plugins/rust_api/rust/src/script/mod.rs#L6-L65)）。
- 从源码构建 FlClash 0.9.1 固定的核心（带 `with_gvisor` 构建标签），用 `-t` 解析每个测试配置，并用它的规则引擎确认一组连接的出口。
- 下载当天的全部上游列表，确认每个都存在、非空、能被核心完整加载，再用它们跑一遍路由测试。上游改名、清空或改坏某个列表时会失败，GitHub 会发邮件。上游暂时访问不了时也会失败，过后重跑即可。仓库 60 天没有活动时 GitHub 会暂停定时任务，需要在 Actions 页面重新启用。
- `rules/` 文件格式；仓库里没有机场地址、凭据、压缩包或数据库文件。
- `router/config.yaml` 和 `override.js` 一致；用 Docker 把 `router/compose.yaml` 当真实网关跑一遍端到端测试（`test/router-e2e.test.mjs`）。

## 失败时会发生什么

| 情况 | 结果 |
| --- | --- |
| 机场配置下载失败，或不是合法 YAML | 保留旧配置，继续使用 |
| 回国机场的节点全部不通 | 必须回国的服务自动改走直连，节点恢复后自动切回 |
| 上游规则集下载失败 | 继续用已缓存的旧版本；首次安装还没有缓存时对应规则为空 |
| 机场结构超出预期，脚本内部出错 | 脚本不抛错，返回“降级配置”：机场配置原样保留，规则只有 `MATCH,DIRECT`，代理页面出现 `⚠️ 回国脚本异常`。网络照常可用 |
| 远程脚本有语法错误、抛错或超时 | 最严重的情况：FlClash 向核心推送空配置，监听端口关闭（[源码](https://github.com/chen08209/FlClash/blob/8d4f9744948751f1273fe871e1d05276fac09b0e/lib/providers/actions/setup.dart#L695-L743)），走系统代理的 App 会断网 |

远程脚本坏掉时：先在 FlClash 里点“暂停”（它自己的下载也走自己的端口，[源码](https://github.com/chen08209/FlClash/blob/8d4f9744948751f1273fe871e1d05276fac09b0e/lib/common/http.dart#L39-L55)）；开 PR `git revert` 坏提交，CI 通过后合并；约 5 分钟后同步脚本，确认 `SCRIPT_VERSION` 是修复版本再启动。急用时也可以在机场配置的“扩展”里取消选择脚本，回到机场原始配置。

## 已知限制

- 名单是白名单：名单外的服务在海外受限时，先切“全局”应急，再把它加进 `rules/return.txt`。
- 爱奇艺、优酷、芒果、腾讯视频“版权校验只在接口上”是推断，没有实测过；B 站、网易云、QQ 音乐有实测依据。某个平台的 CDN 若也校验 IP，把 CDN 域名加进 `return.txt`。
- `return.txt` 的 `video.qq.com` 后缀会带上腾讯视频以外的少量主机；已知的微信视频号和朋友圈视频已在 `direct.txt` 中排除。淘宝的商品视频随淘宝走回国。
- v2fly 的 B 站列表包含 B 站游戏，腾讯音乐列表包含喜马拉雅的 CDN，这些都会走回国。搜狐视频没有合适的列表，默认不回国。
- 机场 DNS 原样保留，直连流量的域名由机场 DNS 解析。机场更换订阅地址时，需要在每台设备上修改订阅。
- 测试使用的 QuickJS-ng 是 0.12.1，FlClash 0.9.1 内置的是 0.15.1，脚本只用两者都支持的语法。

## 本地验证

```bash
npm ci
npm test
```

不设置环境变量时，核心解析和路由测试会被跳过。完整运行需要 Go 1.27 及以上和一份本地 geodata（测试从不下载 geodata）。测试只需要 GeoIP；检查真实机场配置时，它的 DNS 可能用到 `geosite:`，所以把 FlClash 的三个数据文件都复制过去：

```bash
git clone https://github.com/chen08209/Clash.Meta.git .core/Clash.Meta
git -C .core/Clash.Meta checkout 8380d0e7462f061a964323e9bf3129a236fcc5d5
go build -C .core/Clash.Meta -tags with_gvisor -trimpath -o /tmp/mihomo .
go build -C test/route-probe -tags with_gvisor -trimpath -o /tmp/route-probe .
mkdir -p /tmp/geodata
cp "$HOME/Library/Application Support/com.follow.clash/"{GEOIP.metadb,GEOSITE.dat,ASN.mmdb} /tmp/geodata/
MIHOMO_BIN=/tmp/mihomo ROUTE_PROBE_BIN=/tmp/route-probe MIHOMO_GEODATA_DIR=/tmp/geodata npm test
```

用上游当天的完整列表跑路由测试（和 CI 一样；只访问 ruleset.skk.moe 和 raw.githubusercontent.com）：

```bash
npm run fetch-upstream -- /tmp/upstream/geosite /tmp/upstream/sukka
GEOSITE_MRS_DIR=/tmp/upstream/geosite SUKKA_ARTIFACTS_DIR=/tmp/upstream/sukka \
  MIHOMO_BIN=/tmp/mihomo ROUTE_PROBE_BIN=/tmp/route-probe MIHOMO_GEODATA_DIR=/tmp/geodata node --test test/routing.test.mjs
```

用设备上的真实机场配置离线检查：

```bash
MIHOMO_BIN=/tmp/mihomo ROUTE_PROBE_BIN=/tmp/route-probe MIHOMO_GEODATA_DIR=/tmp/geodata \
  node tools/check-profile.mjs "$HOME/Library/Application Support/com.follow.clash/profiles/<id>.yaml"
```

这个工具不联网，不打印配置、服务器地址、URL、IP 或凭据，出错时也只打印打码后的信息。它会打印节点名和组名，节点名可能暴露机场身份，所以不要公开分享输出。这些检查都不会启动代理、监听端口或修改系统网络。

## 文件

- `override.js`：脚本。
- `rules/`：我们自己维护的三份规则。
- `test/`：测试。`fixtures/profiles.mjs` 是虚构的机场配置，`route-probe/` 是基于固定核心的路由探针。
- `tools/check-profile.mjs`：用本地真实配置做离线检查。`tools/fetch-upstream.mjs`：下载并检查脚本用到的全部上游列表。
- `router/`：NAS 旁路由的生成配置、Container Station 应用配置、部署说明和切换模式的 `router-mode`。`tools/build-router-config.mjs`：生成 `router/config.yaml`。
- `.github/workflows/test.yml`：CI。

## 致谢和许可

- v2fly/domain-list-community 为 MIT 许可，由 MetaCubeX/meta-rules-dat 构建发布。Sukka 的规则为 AGPL-3.0。
- 本仓库引用规则地址，不分发规则文件。只复制了少量单条域名：`rules/` 里的淘宝、政务条目取自 v2fly（MIT），银行条目参考了 blackmatrix7 的列表；`test/support/route-probe.mjs` 的测试样例取自 v2fly（经 MetaCubeX 构建，MIT）和 Sukka（AGPL-3.0）。
- 使用 ruleset.skk.moe 即表示接受它的隐私政策。部分机场的服务条款对使用第三方规则有约定，Sukka 的 README 有说明。
