// Cloudflare Worker：静态资源（public/）+ 同源 API 中转
//
// 为什么需要这一层：浏览器带 Origin 直接打 openwebapi.oceanbase.com 会被网关 403，
// 所以由 Worker 在边缘抓取，页面只请求同源的 /api/snapshot。
// 缓存两层：isolate 内 TTL（lib/upstream.mjs）+ 边缘 Cache API（12 秒，全机房共享）。
import { configure, getCampId, getSnapshot, getTotalBoard, getTrackBoard } from '../lib/upstream.mjs';
import { toCsv } from '../api/_csv.mjs';

const TTL_SECONDS = 12;
// 过期后先给旧数据、后台再刷（stale-while-revalidate）：上游一次抓全量要 3~11 秒，
// 直接等会以为页面卡死。只要还在这段时间内，访问者永远秒回。
const STALE_SECONDS = 300;
// Durable Object 里的上游轮询周期：有浏览器连着才轮询
const PUSH_INTERVAL_MS = 15000;

const isForce = (url) => url.searchParams.get('force') === '1' || url.searchParams.get('refresh') === '1';

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
      ...extra,
    },
  });
}

// 去掉 force/refresh 再拼缓存键，避免强制刷新把正常缓存顶掉
function cacheKeyFor(request, extra = '') {
  const u = new URL(request.url);
  const q = new URLSearchParams(u.search);
  q.delete('force');
  q.delete('refresh');
  const qs = q.toString();
  return new Request(`${u.origin}${u.pathname}${extra}${qs ? '?' + qs : ''}`, { method: 'GET' });
}

function storeCache(data) {
  return new Response(JSON.stringify(data), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'x-data-at': String(Date.now()),
      'Cache-Control': `public, max-age=${TTL_SECONDS}`,
    },
  });
}

async function cachedJson(request, ctx, loader, extraKey = '') {
  const force = isForce(new URL(request.url));
  const cache = caches.default;
  const key = cacheKeyFor(request, extraKey);

  if (!force) {
    const hit = await cache.match(key);
    if (hit) {
      const at = Number(hit.headers.get('x-data-at') || 0);
      const age = Math.round((Date.now() - at) / 1000);
      if (age < TTL_SECONDS) {
        return json(JSON.parse(await hit.text()), 200, { 'X-Cache': 'HIT', 'X-Data-Age': String(age) });
      }
      if (age < STALE_SECONDS) {
        // 过期但还新鲜：立刻回旧数据，后台刷新边缘缓存
        ctx.waitUntil(
          (async () => {
            try {
              const data = await loader();
              await cache.put(key, storeCache(data));
            } catch {
              /* 后台刷新失败就用旧数据顶着 */
            }
          })(),
        );
        return json(JSON.parse(await hit.text()), 200, {
          'X-Cache': 'STALE',
          'X-Data-Age': String(age),
          'Cache-Control': 'no-store',
        });
      }
    }
  }

  const data = await loader();
  ctx.waitUntil(cache.put(key, storeCache(data)));
  return json(data, 200, { 'X-Cache': force ? 'BYPASS' : 'MISS' });
}

// 赛道榜没有学校/导师，用总榜 userId 关联补齐（与本地 server.mjs 口径一致）
async function enrichWithTotal(rows) {
  const total = await getTotalBoard();
  const info = new Map(total.rows.filter((r) => r.userId).map((r) => [r.userId, r]));
  return rows.map((r) => {
    const hit = r.userId && info.get(r.userId);
    if (!hit || r.school) return r;
    return { ...r, school: hit.school, advisor: r.advisor || hit.advisor, province: r.province || hit.province };
  });
}


// WebSocket 帧不做 HTTP 压缩，975KB 的 JSON 每 15 秒推一次太费流量 → 这里手动 gzip
async function gzipJson(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return await new Response(stream).arrayBuffer();
}


// ================================================================== 访问统计
// 只统计聚合量：PV / UV / 来源 / 地区 / 设备 / 榜单点击 / CSV 下载 / 外链点击。
// UV 用「当天盐 + IP + UA」的短哈希去重，不落原始 IP，也不写 cookie。

const STATS_TZ_OFFSET_MS = 8 * 3600 * 1000; // 按北京时间切天

function dayKey(ts = Date.now()) {
  return new Date(ts + STATS_TZ_OFFSET_MS).toISOString().slice(0, 10);
}

function referrerBucket(ref) {
  if (!ref) return '直接访问';
  let host = '';
  try {
    host = new URL(ref).hostname.replace(/^www\./, '');
  } catch {
    return '其他';
  }
  if (!host) return '直接访问';
  if (/(^|\.)github\.io$|(^|\.)github\.com$/.test(host)) return 'GitHub';
  if (/(^|\.)(feishu\.cn|larksuite\.com|larkoffice\.com)$/.test(host)) return '飞书';
  if (/(^|\.)(weixin\.qq\.com|qq\.com|wechat\.com)$/.test(host)) return '微信/QQ';
  if (/(^|\.)(google|bing|baidu|sogou|so\.com|duckduckgo)\./.test(host)) return '搜索引擎';
  if (/(^|\.)(x\.com|twitter\.com|weibo\.com|zhihu\.com|juejin\.cn|v2ex\.com)$/.test(host)) return '社交平台';
  return host;
}

function deviceOf(ua = '') {
  if (/bot|crawler|spider|headless|python-requests|curl\//i.test(ua)) return 'bot';
  if (/iPad|Tablet/i.test(ua)) return 'tablet';
  if (/Mobi|Android|iPhone|iPod/i.test(ua)) return 'mobile';
  return 'desktop';
}

async function visitorHash(ip, ua, day) {
  const raw = `${day}|${ip}|${ua}|seekdb-board`;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return [...new Uint8Array(buf).slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class BoardStats {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.days = new Map(); // dateKey -> bucket
    this.uv = new Map(); // dateKey -> Set(hash)
  }

  async loadDay(day) {
    if (!this.days.has(day)) {
      const stored = (await this.state.storage.get(`d:${day}`)) || {};
      this.days.set(day, {
        pv: stored.pv || 0,
        uv: stored.uv || 0,
        boards: stored.boards || {},
        csv: stored.csv || 0,
        out: stored.out || 0,
        refs: stored.refs || {},
        geo: stored.geo || {},
        dev: stored.dev || {},
      });
      this.uv.set(day, new Set((await this.state.storage.get(`u:${day}`)) || []));
    }
    return this.days.get(day);
  }

  async persist(day) {
    await this.state.storage.put(`d:${day}`, this.days.get(day));
    await this.state.storage.put(`u:${day}`, [...(this.uv.get(day) || [])].slice(0, 20000));
  }

  bump(obj, key, n = 1) {
    obj[key] = (obj[key] || 0) + n;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/hit')) {
      let evt = {};
      try {
        evt = await request.json();
      } catch {
        return json({ ok: false }, 400);
      }
      return this.hit(evt, request);
    }
    if (url.pathname.endsWith('/summary')) {
      const days = Math.min(60, Math.max(1, Number(url.searchParams.get('days') || 7)));
      return json(await this.summary(days));
    }
    return json({ error: 'not found' }, 404);
  }

  async hit(evt, request) {
    const kind = String(evt.k || '').slice(0, 12);
    const day = dayKey();
    const b = await this.loadDay(day);
    const ua = request.headers.get('user-agent') || '';
    const dev = deviceOf(ua);

    if (kind === 'pv') {
      if (dev === 'bot') {
        this.bump(b.dev, 'bot');
      } else {
        b.pv += 1;
        this.bump(b.dev, dev);
        const country = request.headers.get('x-geo') || '未知';
        this.bump(b.geo, country);
        this.bump(b.refs, referrerBucket(evt.r));
        const ip = request.headers.get('cf-connecting-ip') || '0.0.0.0';
        const h = await visitorHash(ip, ua, day);
        const set = this.uv.get(day);
        if (!set.has(h)) {
          set.add(h);
          b.uv = set.size;
        }
      }
    } else if (kind === 'board') {
      this.bump(b.boards, String(evt.t || evt.b || '未知').slice(0, 40));
    } else if (kind === 'csv') {
      b.csv += 1;
    } else if (kind === 'out') {
      b.out += 1;
    }

    await this.persist(day);
    return json({ ok: true }, 200, { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
  }

  async summary(days) {
    const out = [];
    const today = Date.now();
    for (let i = days - 1; i >= 0; i -= 1) {
      const day = dayKey(today - i * 86400000);
      if (!this.days.has(day)) await this.loadDay(day);
      const b = this.days.get(day);
      out.push({ day, pv: b.pv, uv: b.uv, csv: b.csv, out: b.out });
    }
    const totals = { pv: 0, uv: 0, csv: 0, out: 0 };
    const merge = { boards: {}, refs: {}, geo: {}, dev: {} };
    for (const day of out) {
      // 汇总区间内的分布（跨天累加）
      const b = this.days.get(day.day);
      totals.pv += b.pv;
      totals.csv += b.csv;
      totals.out += b.out;
      for (const k of Object.keys(merge)) {
        for (const [kk, vv] of Object.entries(b[k] || {})) merge[k][kk] = (merge[k][kk] || 0) + vv;
      }
    }
    // 区间 UV 用「最近一天」的日 UV 近似会低估，这里给出每天的 uv 序列，不做跨天去重
    totals.uv = out.length ? out[out.length - 1].uv : 0;

    const top = (obj, n = 8) =>
      Object.entries(obj)
        .sort((a, b) => b[1] - a[1])
        .slice(0, n)
        .map(([name, count]) => ({ name, count }));
    const last = this.days.get(out[out.length - 1].day) || {};
    return {
      ok: true,
      days,
      today: out[out.length - 1],
      todayBoards: last.boards || {},
      series: out,
      totals,
      boards: top(merge.boards),
      refs: top(merge.refs),
      geo: top(merge.geo),
      dev: top(merge.dev),
    };
  }
}

// ------------------------------------------------------------------ 推送中枢
// Durable Object：有浏览器连着时，每 15 秒抓一次上游，抓到就 push 给所有连接，
// 浏览器不用自己轮询（轮询只在推送连不上时兜底）。
export class BoardHub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sockets = new Set();
    this.snapshot = null;
    this.ready = state.blockConcurrencyWhile(async () => {
      this.snapshot = (await state.storage.get('snapshot')) || null;
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/api/stream') return this.stream(request);
    if (url.pathname === '/api/online') {
      return json({ sockets: this.sockets.size, lastPush: this.lastPushAt || null, intervalMs: PUSH_INTERVAL_MS });
    }
    await this.ready;
    return json(this.snapshot ? { ...this.snapshot, push: { intervalMs: PUSH_INTERVAL_MS, clients: this.sockets.size } } : { pending: true }, 200, {
      'Cache-Control': 'no-store',
    });
  }

  async stream(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return json({ error: 'expected websocket' }, 426);
    }
    await this.ready;
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.sockets.add(server);
    const drop = () => this.sockets.delete(server);
    server.addEventListener('close', drop);
    server.addEventListener('error', drop);
    if (this.snapshot) {
      try {
        server.send(await gzipJson(JSON.stringify(this.snapshot)));
      } catch {
        /* 忽略单连接失败 */
      }
    }
    await this.arm();
    return new Response(null, { status: 101, webSocket: client });
  }

  async arm() {
    const cur = await this.state.storage.getAlarm();
    if (cur == null) await this.state.storage.setAlarm(Date.now() + 300);
  }

  async alarm() {
    // 没人连就不轮询，省 CPU / 上游请求
    if (this.sockets.size === 0) return;
    try {
      const snap = await getSnapshot({ force: true });
      this.snapshot = snap;
      await this.state.storage.put('snapshot', snap);
      const body = await gzipJson(JSON.stringify(snap));
      for (const ws of this.sockets) {
        try {
          ws.send(body);
        } catch {
          this.sockets.delete(ws);
        }
      }
    } catch {
      /* 上游失败：连着的浏览器继续看上一版 */
    }
    if (this.sockets.size > 0) await this.state.storage.setAlarm(Date.now() + PUSH_INTERVAL_MS);
  }
}

// ------------------------------------------------------------------ 统计后台页
// 只有带正确 STATS_KEY 才能打开（错误 key 直接 404，不暴露页面存在）。
function statsPageHtml(key) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="robots" content="noindex,nofollow" />
<title>看板访问统计</title>
<style>
:root{--bg:#f4f7fb;--panel:#fff;--line:#dfe7f2;--text:#12233d;--muted:#6b7e99;--accent:#086fff;--accent2:#0f9d76;--warm:#e08a00}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
header{display:flex;align-items:center;gap:14px;padding:18px 24px;background:var(--panel);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:5}
h1{font-size:16px;margin:0;font-weight:650}
.tag{font-size:11px;color:var(--muted);border:1px solid var(--line);border-radius:99px;padding:2px 8px}
.spacer{flex:1}
select,button{font:inherit;border:1px solid var(--line);background:#fff;color:var(--text);border-radius:8px;padding:5px 10px;cursor:pointer}
main{padding:20px 24px 40px;max-width:1180px;margin:0 auto;display:grid;gap:16px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.card .k{font-size:12px;color:var(--muted)}
.card .v{font-size:26px;font-weight:650;letter-spacing:-.02em;margin-top:2px}
.card .s{font-size:11px;color:var(--muted);margin-top:2px}
.card.hot .v{color:var(--warm)}
.card.on .v{color:var(--accent2)}
section{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px}
h2{font-size:13px;margin:0 0 12px;color:var(--muted);font-weight:600;letter-spacing:.02em}
.chart{width:100%;height:190px;display:block}
.legend{display:flex;gap:16px;font-size:12px;color:var(--muted);margin-top:8px}
.legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:5px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:760px){.grid2{grid-template-columns:1fr}}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line)}
th{font-size:11px;color:var(--muted);font-weight:600}
td.n{text-align:right;font-variant-numeric:tabular-nums}
.bar{height:6px;border-radius:4px;background:var(--accent);opacity:.75}
.bar.wrap{background:#eef3fa}
.empty{color:var(--muted);font-size:13px;padding:8px}
footer{color:var(--muted);font-size:12px;text-align:center;padding:0 24px 32px}
</style>
</head>
<body>
<header>
  <h1>看板访问统计</h1><span class="tag">仅内部可见</span>
  <span class="spacer"></span>
  <select id="range">
    <option value="7">近 7 天</option>
    <option value="14" selected>近 14 天</option>
    <option value="30">近 30 天</option>
  </select>
  <button id="reload">刷新</button>
</header>
<main>
  <div class="cards">
    <div class="card"><div class="k">今日 PV</div><div class="v" id="pv">–</div><div class="s" id="pvs"></div></div>
    <div class="card"><div class="k">今日 UV</div><div class="v" id="uv">–</div><div class="s">按 IP+UA 日去重</div></div>
    <div class="card on"><div class="k">当前在线</div><div class="v" id="online">–</div><div class="s">实时推送连接数</div></div>
    <div class="card hot"><div class="k">榜单切换</div><div class="v" id="boardHits">–</div><div class="s">今日点击次数</div></div>
    <div class="card"><div class="k">CSV 下载</div><div class="v" id="csv">–</div><div class="s">今日</div></div>
    <div class="card"><div class="k">外链点击</div><div class="v" id="out">–</div><div class="s">今日</div></div>
  </div>
  <section>
    <h2>每日访问量</h2>
    <svg class="chart" id="chart" viewBox="0 0 900 190" preserveAspectRatio="none"></svg>
    <div class="legend"><span><i style="background:#086fff"></i>PV</span><span><i style="background:#0f9d76"></i>UV</span></div>
  </section>
  <div class="grid2">
    <section><h2>榜单点击热度</h2><div id="boards"></div></section>
    <section><h2>来源</h2><div id="refs"></div></section>
  </div>
  <div class="grid2">
    <section><h2>地区</h2><div id="geo"></div></section>
    <section><h2>设备</h2><div id="dev"></div></section>
  </div>
  <footer id="foot">数据来自 Worker 端聚合计数（Durable Object），不含原始 IP、不写 cookie。</footer>
</main>
<script>
const KEY = ${JSON.stringify(key)};
const $ = (s) => document.querySelector(s);
const fmt = (n) => (n == null ? '–' : n.toLocaleString('zh-CN'));

function rows(el, list, unit) {
  if (!list || !list.length) { el.innerHTML = '<div class="empty">暂无数据</div>'; return; }
  const max = Math.max(...list.map((r) => r.count));
  el.innerHTML = '<table><thead><tr><th>名称</th><th style="width:45%"></th><th style="text-align:right">次数</th></tr></thead><tbody>'
    + list.map((r) => '<tr><td>' + r.name + '</td><td><div class="bar wrap" style="width:100%"><div class="bar" style="width:' + Math.max(3, (r.count / max) * 100).toFixed(1) + '%"></div></div></td><td class="n">' + fmt(r.count) + (unit || '') + '</td></tr>').join('')
    + '</tbody></table>';
}

function chart(series) {
  const svg = $('#chart');
  const W = 900, H = 190, pad = { l: 40, r: 12, t: 10, b: 22 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const max = Math.max(1, ...series.flatMap((d) => [d.pv, d.uv]));
  const n = Math.max(1, series.length);
  const bw = iw / n;
  const y = (v) => pad.t + ih - (v / max) * ih;
  let out = '';
  for (let i = 0; i <= 3; i += 1) {
    const v = Math.round((max / 3) * i);
    out += '<line x1="' + pad.l + '" x2="' + (W - pad.r) + '" y1="' + y(v) + '" y2="' + y(v) + '" stroke="#eef3fa" stroke-width="1"/>';
    out += '<text x="' + (pad.l - 6) + '" y="' + (y(v) + 3.5) + '" font-size="10" fill="#9fb0c7" text-anchor="end">' + v + '</text>';
  }
  series.forEach((d, i) => {
    const x0 = pad.l + i * bw;
    const w = Math.max(1.5, bw * 0.32);
    out += '<rect x="' + (x0 + bw * 0.16) + '" y="' + y(d.pv) + '" width="' + w + '" height="' + (pad.t + ih - y(d.pv)) + '" fill="#086fff" opacity=".85" rx="2"><title>' + d.day + ' PV ' + d.pv + '</title></rect>';
    out += '<rect x="' + (x0 + bw * 0.52) + '" y="' + y(d.uv) + '" width="' + w + '" height="' + (pad.t + ih - y(d.uv)) + '" fill="#0f9d76" opacity=".85" rx="2"><title>' + d.day + ' UV ' + d.uv + '</title></rect>';
    if (n <= 16 || i % Math.ceil(n / 10) === 0) {
      out += '<text x="' + (x0 + bw / 2) + '" y="' + (H - 6) + '" font-size="10" fill="#9fb0c7" text-anchor="middle">' + d.day.slice(5) + '</text>';
    }
  });
  svg.innerHTML = out;
}

async function load() {
  const days = $('#range').value;
  const r = await fetch('/api/stats?days=' + days + '&key=' + encodeURIComponent(KEY), { cache: 'no-store' });
  if (!r.ok) { $('#foot').textContent = '读取失败：' + r.status; return; }
  const d = await r.json();
  $('#pv').textContent = fmt(d.today.pv);
  $('#uv').textContent = fmt(d.today.uv);
  $('#online').textContent = fmt(d.online);
  $('#boardHits').textContent = fmt(Object.values(d.todayBoards || {}).reduce((a, b) => a + b, 0));
  $('#csv').textContent = fmt(d.today.csv);
  $('#out').textContent = fmt(d.today.out);
  $('#pvs').textContent = '近 ' + days + ' 天共 ' + fmt(d.totals.pv) + ' 次';
  chart(d.series);
  rows($('#boards'), d.boards);
  rows($('#refs'), d.refs);
  rows($('#geo'), d.geo);
  rows($('#dev'), d.dev);
  $('#foot').textContent = '更新于 ' + new Date().toLocaleString('zh-CN') + ' · 数据来自 Worker 端聚合计数（Durable Object），不含原始 IP、不写 cookie。';
}
$('#range').addEventListener('change', load);
$('#reload').addEventListener('click', load);
load();
setInterval(load, 30000);
</script>
</body>
</html>`;
}

export default {
  async fetch(request, env, ctx) {
    if (env?.CAMP_ID != null) configure({ campId: env.CAMP_ID });
    if (env?.CACHE_TTL_MS != null) configure({ ttlMs: env.CACHE_TTL_MS });

    const url = new URL(request.url);
    const p = url.pathname;

    if (p === '/api/health') {
      let gz = null;
      try {
        gz = (await gzipJson('x'.repeat(4096))).byteLength;
      } catch (e) {
        gz = 'error: ' + (e.message || e);
      }
      return json({
        ok: true,
        campId: getCampId(),
        cacheTtlMs: TTL_SECONDS * 1000,
        at: new Date().toISOString(),
        runtime: 'cloudflare-worker',
        push: { intervalMs: PUSH_INTERVAL_MS, compression: typeof CompressionStream, gzip4096: gz },
      });
    }

    try {
      // 访问统计：前端 sendBeacon 打点（text/plain 避免预检）
      if (p === '/api/hit' && env?.BOARD_STATS) {
        if (request.method === 'OPTIONS') {
          return new Response(null, {
            status: 204,
            headers: {
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Methods': 'POST, OPTIONS',
              'Access-Control-Allow-Headers': 'content-type',
              'Access-Control-Max-Age': '86400',
            },
          });
        }
        const stats = env.BOARD_STATS.get(env.BOARD_STATS.idFromName('camp21'));
        // request.cf 只在主 Worker 请求里存在，DO 里拿不到 → 用头传过去
        const fwd = new Headers(request.headers);
        fwd.set('x-geo', request.cf?.country || '未知');
        return stats.fetch(new Request('https://stats/hit', { method: 'POST', body: request.body, headers: fwd }));
      }

      if (p === '/api/stats' && env?.BOARD_STATS) {
        const key = env?.STATS_KEY || '';
        if (!key || url.searchParams.get('key') !== key) return json({ error: 'not found' }, 404);
        const stats = env.BOARD_STATS.get(env.BOARD_STATS.idFromName('camp21'));
        const days = url.searchParams.get('days') || '7';
        const res = await stats.fetch(new Request(`https://stats/summary?days=${days}`));
        const body = await res.json();
        // 在线人数来自推送中枢
        let online = 0;
        if (env?.BOARD_HUB) {
          try {
            const hub = env.BOARD_HUB.get(env.BOARD_HUB.idFromName('camp21'));
            const r = await hub.fetch(new Request('https://hub/api/online'));
            online = (await r.json()).sockets || 0;
          } catch {
            /* 忽略 */
          }
        }
        return json({ ...body, online }, 200, { 'Cache-Control': 'no-store' });
      }

      if (p === '/api/online' && env?.BOARD_HUB) {
        const hub = env.BOARD_HUB.get(env.BOARD_HUB.idFromName('camp21'));
        const res = await hub.fetch(new Request('https://hub/api/online'));
        let body = null;
        try {
          body = await res.json();
        } catch {
          body = null;
        }
        // DO 刚部署后会短暂跑旧代码（旧版对未知路径返回快照），这里做兼容归一化
        const sockets = Number(body?.sockets ?? body?.push?.clients ?? 0);
        return json(
          { sockets: Number.isFinite(sockets) ? sockets : 0, lastPush: body?.lastPush || null, intervalMs: PUSH_INTERVAL_MS },
          200,
          { 'Cache-Control': 'no-store' },
        );
      }

      if (p === '/stats') {
        const key = env?.STATS_KEY || '';
        if (!key) return new Response('stats not configured', { status: 503 });
        if (url.searchParams.get('key') !== key) return new Response('Not found', { status: 404 });
        return new Response(statsPageHtml(key), {
          headers: { 'content-type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
        });
      }

      if ((p === '/api/stream' || p === '/api/latest') && env?.BOARD_HUB) {
        const hub = env.BOARD_HUB.get(env.BOARD_HUB.idFromName('camp21'));
        return hub.fetch(request);
      }

      if (p === '/api/snapshot' && env?.BOARD_HUB) {
        // 推送中枢手里已经有最新快照就直接用，避免同一份数据抓两遍
        try {
          const hub = env.BOARD_HUB.get(env.BOARD_HUB.idFromName('camp21'));
          const res = await hub.fetch(new Request('https://hub/api/latest'));
          const body = await res.json();
          if (body && Array.isArray(body.boards)) {
            return json(body, 200, { 'X-Source': 'durable-object', 'Cache-Control': 'no-store' });
          }
        } catch {
          /* 退回直连上游 */
        }
      }

      if (p === '/api/snapshot') {
        const force = isForce(url);
        return await cachedJson(request, ctx, () => getSnapshot({ force }));
      }

      if (p.startsWith('/api/board/')) {
        const id = decodeURIComponent(p.slice('/api/board/'.length));
        const force = isForce(url);
        if (id === 'total') return await cachedJson(request, ctx, () => getTotalBoard({ force }), 'total');
        const qid = id.replace(/^q/, '');
        if (!/^\d+$/.test(qid)) return json({ error: 'board must be "total" or "q<questionId>"' }, 400);
        return await cachedJson(request, ctx, () => getTrackBoard(qid, { force }), `q${qid}`);
      }

      if (p === '/api/export.csv') {
        const raw = url.searchParams.get('board') || 'total';
        const force = isForce(url);
        const questionId = raw.replace(/^q/, '');
        const isTotal = raw === 'total';
        if (!isTotal && !/^\d+$/.test(questionId)) {
          return json({ error: 'board must be "total" or "q<questionId>"' }, 400);
        }
        const board = isTotal
          ? { kind: 'total', questionId: null, rows: (await getTotalBoard({ force })).rows }
          : { kind: 'track', questionId, rows: await enrichWithTotal((await getTrackBoard(questionId, { force })).rows) };
        const fname = `oceanbase-${isTotal ? 'total' : 'track-' + questionId}-${new Date().toISOString().slice(0, 10)}.csv`;
        return new Response(toCsv(board), {
          headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="${fname}"`,
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-store',
          },
        });
      }

      if (p.startsWith('/api/')) return json({ error: 'unknown endpoint' }, 404);
    } catch (err) {
      return json({ error: 'upstream failure', detail: err.message || String(err) }, 502);
    }

    // 其余请求交给静态资源（wrangler assets）
    if (env?.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  },
};
