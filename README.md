# OceanBase 榜单实时看板

**在线地址：<https://zzstar101.github.io/oceanbase-live-board/>**
（GitHub Pages 静态版，Actions 每 10 分钟重抓一次上游；数据新鲜度见页面右上角状态灯）

把 open.oceanbase.com 上的 **数据库大赛总榜（初赛英雄榜）** 和 **seekdb AI 训练营 11 个赛道榜** 抓成一份可实时刷新的看板。
零依赖 Node（`node:http` + 原生 `fetch`），一条命令启动。

页面默认只显示 Top 10，本看板直连同一套公开接口并带 `pageSize=5000`，拿的是**全量**：

| 榜单 | 条数（2026-10-29 抓取） |
| --- | --- |
| 总榜 · 初赛英雄榜 | 622 |
| seekdb 基础实践 `600071` | 579 |
| PowerContext 题目 `600070` | 467 |
| seekdb题目 `600069` | 359 |
| 高德地图 `600074` | 306 |
| ModelScope `600075` | 303 |
| seekdb 性能优化 `600080` | 273 |
| StepFun `600073` | 236 |
| Qoder `600078` | 222 |
| Dify `600076` | 214 |
| AMD `600072` | 11 → 15（进行中） |
| MiniMax `600077` | 1 |

![总榜](docs/screenshot-total.png)

## 启动

```bash
cd oceanbase-live-board
node server.mjs          # 或 npm start
# → http://127.0.0.1:8791
```

要求 Node ≥ 20（用到内置 `fetch` / `AbortSignal.timeout`），无任何 npm 依赖，`npm install` 可跳过。

## 部署

浏览器**不能**直接轮询上游接口 —— 实测任何非 `open.oceanbase.com` 的 `Origin` 都被网关 403（`Origin: https://<user>.github.io` → 403，补 `Referer` 也一样；只有 `Origin: https://open.oceanbase.com` 通过），响应也没有 `Access-Control-Allow-Origin`，`no-cors` 拿不到 body，接口也没有 JSONP。公共 CORS 代理同样不可靠（allorigin 520 / codetabs 522 / corsproxy.io 需 key / cors.lol 429）。

所以「页面侧轮询」必须有一个**同源的重写/中转**，三种做法：

| 部署方式 | 数据新鲜度 | 需要什么 | 成本 |
| --- | --- | --- | --- |
| **Vercel**（`api/` 函数 + `public/` 静态） | 真实时（12s CDN 缓存） | Vercel 账号 | 免费额度足够 |
| Cloudflare Worker / 任何 Node 主机 | 真实时 | 对应账号 | 免费额度足够 |
| **GitHub Pages**（Actions 定时抓快照，当前线上方案） | 跟随 workflow 周期（10 分钟） | 只要仓库 | 免费 |

### Vercel

```
public/      # 静态前端（零配置直接托管）
api/         # serverless 函数，和 localhost 的 server.mjs 同源同路由
  snapshot.js         GET /api/snapshot[?force=1]
  board/[id].js       GET /api/board/total | /api/board/q600071
  export.csv.js       GET /api/export.csv?board=<id>
  health.js           GET /api/health
vercel.json  # outputDirectory=public, 函数 maxDuration=30s
```

```bash
npx vercel login          # 只需一次
cd oceanbase-live-board
npx vercel --prod         # 首跑会问项目名，接受默认即可
```

也可以在 Vercel 面板里 Import 这个仓库，零配置（静态目录 `public`、函数目录 `api` 都按约定识别）。函数响应带 `Cache-Control: public, s-maxage=12, stale-while-revalidate=120`，所有访客共享 CDN 缓存，上游最多每 12 秒被打一次。

### GitHub Pages + Cloudflare Worker（当前线上方案）

Pages 只托管静态文件，所以线上是「静态外壳 + 远程实时 API」：

- **页面**：<https://zzstar101.github.io/oceanbase-live-board/> —— 纯静态，Actions 部署
- **实时数据**：<https://board.fireflydle.games/api/*> —— Cloudflare Worker（跨域 `Access-Control-Allow-Origin: *`，边缘缓存 12 秒）
- **兜底**：Worker 不可达时前端自动读 `data/snapshot.json`（Actions 每 10 分钟重抓一次）

这样页面在 GitHub Pages 上，数据照样 15 秒一轮真·实时，不依赖 Pages 的构建周期。

> 为什么不用 `*.workers.dev`：本机网络对 workers.dev 的 SNI 被阻断（DNS 被污染到 192.133.77.197，直连真实 CF IP 也 `Connection reset`），而 `www.cloudflare.com` / `api.cloudflare.com` 正常 —— 所以给 Worker 挂了自有域名 `board.fireflydle.games`（`wrangler.jsonc` 里 `routes[].custom_domain`）。

| 模式 | 判定 | 数据来源 | 刷新 |
| --- | --- | --- | --- |
| 本地 / Vercel / Worker 直接托管 | 同源 `/api/snapshot` 返回 JSON | 服务端实时抓取 | 5~60 秒可调 |
| GitHub Pages | 构建时注入 `window.__STATIC_DATA__` | 远程 Worker `/api/snapshot`；失败再用 `data/snapshot.json` | 15 秒；静态兜底 ≥60 秒 |

顶栏会直说数据年龄：实时模式「实时 · 3 秒前」，静态兜底「静态快照 · 生成于 3 分钟前」。CSV 导出跟随实际数据源。

```bash
node scripts/build-data.mjs                 # 生成 dist/（快照兜底）
python3 -m http.server 8792 -d dist         # 本地预览静态版
npx wrangler deploy                         # 上线 Worker（含自定义域）
```

启用：仓库 Settings → Pages → Source 选 **GitHub Actions**，再跑一次 `.github/workflows/pages.yml`（schedule / push / 手动 dispatch 均触发）。上游抓取失败时 job 失败、旧页面保持不变。

## 功能

- **全量榜单**：总榜 + 全部赛道，侧边栏按参与人数排序，可再筛选。
- **实时刷新**：默认 15 秒（5/15/30/60 秒可选），页面切到后台自动暂停轮询，回到前台立刻补一次。
- **变动追踪**：与上一版快照对比，名次升降显示 ▲/▼，分数增量显示 `+x.xxx`，新出现的记录标 `NEW`，变化的行有一次高亮闪烁；`只看变动` 可过滤。
- **搜索 / 排序**：按队名、学校、导师、省份过滤；表头点击排序（成绩与提交时间默认降序）。
- **队伍详情抽屉**：点任意一行，看学校 / 导师 / 省份 / 最优提交时间，以及该队在**每个赛道**的名次与得分（总榜与赛道通过 `userId` 关联）。
- **导出 CSV**：当前榜单全量导出，UTF-8 BOM，Excel 直接打开不乱码。
- **实时在线人数**：顶栏「在线 N」= 当前挂在这条实时推送（WebSocket）上的连接数，20~30 秒刷新一次。

![赛道榜与详情抽屉](docs/screenshot-track-drawer.png)

## 架构

```
oceanbase-live-board/
├── server.mjs            # 本地：node:http 静态服务 + /api 路由 + gzip
├── lib/upstream.mjs      # 上游接口封装、字段归一化、TTL 缓存、stale-while-error（本地与 serverless 共用）
├── api/                  # Vercel serverless 版同一套路由
│   ├── snapshot.js  board/[id].js  export.csv.js  health.js
│   └── _csv.mjs          # CSV 序列化（下划线开头，不暴露成路由）
├── scripts/build-data.mjs # GitHub Pages 静态构建：抓快照 → dist/
├── .github/workflows/pages.yml
├── vercel.json
├── public/
│   ├── index.html        # 结构与文案
│   ├── styles.css        # 浅色主题，CSS 变量
│   └── app.js            # 轮询、diff、渲染、抽屉、CSV
└── docs/                 # 截图
```

服务端缓存 12 秒：多个浏览器标签页 / 多人访问只会打到上游一次；上游抖动时继续供最后一次成功数据，并在顶栏与横幅提示「使用缓存」。

## 接口

| 路由 | 说明 |
| --- | --- |
| `GET /api/health` | 存活 + campId + 缓存 TTL |
| `GET /api/snapshot` | 一次返回总榜 + 全部赛道（gzip 后约 155 KB） |
| `GET /api/snapshot?force=1` | 跳过缓存强制刷新 |
| `GET /api/board/<id>` | 单个榜单，`id` = `total` 或 `q<questionId>` |
| `GET /api/export.csv?board=<id>` | 导出该榜单 CSV |
| `GET /api/online` | 当前在线人数（实时推送连接数） |
| `POST /api/hit` | 访问打点（`{k:"pv"\|"board"\|"csv"\|"out"}`，返回 `{"ok":true}`） |
| `GET /api/stats?key=<STATS_KEY>&days=7` | 访问统计汇总（JSON，无 key 或 key 错一律 404） |
| `GET /stats?key=<STATS_KEY>` | 统计后台页（HTML，无 key 或 key 错一律 404） |

### 上游接口（公开、免登录）

```
题目列表  GET https://openwebapi.oceanbase.com/api/techcamp/testplatform/question/webQueryTestPlatformQuestionList
             ?rpcFromType=0&campId=21&pageSize=200&pageNo=1
赛道榜    GET .../testplatform/score/queryTestPlatformScoreList?questionId=600071&pageSize=5000
总榜      GET .../testplatform/score/queryCompetitionScoreList
             ?rpcFromType=0&pageNo=1&pageSize=5000&campId=21&scoreType=0
```

踩过的坑（都已在代码里处理）：

- `queryTestPlatformScoreList` **忽略 `pageNum`**，`pageSize` 等价于 LIMIT，响应里的 `total` 只是本次返回条数，不是真实总数；前端页面不传 `pageSize` ⇒ 服务端默认 10 条 ⇒ 页面只显示 Top 10。
- `queryCompetitionScoreList` 是**真分页**（`pageNo` 生效，`total` 可信）；必须同时带 `campId=21` 与 `scoreType=0`，否则 400 或空数据。
- 赛道榜字段用 `userName`，总榜用 `groupName`；时间字段是 UTC（`gmtCreate` = 页面「最优提交时间」/「最优成绩提交日」，`gmtModified` = 该记录的更新时间）。

## 访问统计

六项指标全部由 Worker 自己统计（`BoardStats` Durable Object，按北京时间切天），不依赖第三方脚本：

| 指标 | 口径 |
| --- | --- |
| PV / UV | 每次页面加载记 1 次 PV；UV 按 `hash(IP + UA + 日期盐)` 去重（不落原始 IP） |
| 来源 | `document.referrer` 归到 GitHub / 飞书 / 微信·QQ / 搜索引擎 / 社交平台 / 直接访问 |
| 地区 / 设备 | `request.cf.country`（主 Worker 用 `x-geo` 头传给 DO）；UA 归到 desktop / mobile / tablet / bot |
| 榜单点击热度 | 侧边栏切榜时打点，按榜单标题计数 |
| CSV 下载 / 外链点击 | 导出按钮、上游原始页链接点击各记一次 |
| 当前在线 | 实时推送（WebSocket）连接数，`/api/online` 与后台页「当前在线」卡片 |

后台地址：`https://board.fireflydle.games/stats?key=<STATS_KEY>`（支持 7/14/30 天，30 秒自动刷新）。

![访问统计后台](docs/screenshot-stats.png)
`STATS_KEY` 用 `wrangler secret put STATS_KEY` 设置（值存在仓库外的 `.stats-key`，已 gitignore）；**没配 key 时 `/stats` 返回 503，key 不对返回 404，不暴露页面存在**。

隐私：只记聚合计数（PV/UV/事件/来源桶/国家/设备类型），不存原始 IP、不写 cookie、不采集任何页面内容；hash 用日期盐，跨天不可关联。

> 想再要一份 Cloudflare 官方的独立统计（PV/UV/来源/地区/设备，在 CF 后台看），可在 Cloudflare 控制台 → Web Analytics 手动添加 `board.fireflydle.games` 拿 beacon token——wrangler 的 OAuth token 没有 `analytics/rum` 权限，脚本建不了站点。自定义事件（榜单点击/CSV/在线）Web Analytics 不支持，所以这几项仍然只在本项目后台里。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8791` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址，局域网访问改成 `0.0.0.0` |
| `CAMP_ID` | `21` | 只测过 21；其它 camp 在上游返回 500 |
| `CACHE_TTL_MS` | `12000` | 上游结果缓存时长 |
| `UPSTREAM_TIMEOUT_MS` | `15000` | 单次上游请求超时（带 3 次退避重试） |
| `STATS_KEY`（Worker secret） | 无 | 统计后台 `/stats` 与 `/api/stats` 的访问口令；不配则后台不可用 |

## 已知局限

- **总榜成绩 ≠ 各赛道成绩之和**。逐队核对过：622 队里只有 372 队吻合，其余口径不同（例如 `idmg123` 总榜 600、赛道累加 480）。所以详情抽屉里的「本地累加参考」只是参考，不做断言。
- 上游没有个人提交历史可抓：`queryUserScoreRank` 需要 `userId`，`queryTestPlatformTaskRecordList` 需要登录 token（401 暂未登录）。看板只做榜单，不做登录态功能。
- 名次由本看板按成绩重算（同分并列，如总榜三个 600 分并列 No.1）；页面本身也是前端 `index+1`，同分时的顺序以接口返回顺序为准。
- 数据实时性受上游缓存影响，实测两次抓取间隔内会有 1~4 条增量，属于正常。
