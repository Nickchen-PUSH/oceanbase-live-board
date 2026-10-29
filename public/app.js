// Frontend for the OceanBase leaderboard dashboard.
// Polls /api/snapshot (server keeps a TTL cache + stale-while-error), diffs against the
// previous snapshot to show rank/score movement, and lets you drill into one team's
// per-track breakdown.

const $ = (sel, root = document) => root.querySelector(sel);

const state = {
  snapshot: null,
  prev: null, // previous snapshot (for diffing)
  boardId: 'total',
  search: '',
  onlyChanged: false,
  sort: { key: 'rank', dir: 1 },
  auto: true,
  interval: 15000,
  lastSuccess: 0,
  loading: false,
  error: null,
  changedKeys: new Set(), // keys that moved on the latest update (for flash)
  drawerRow: null,
  apiBase: '', // 实时 API 的 origin（同源为空串，GitHub Pages 形态下是 Worker 域名）
  metric: 'avg', // 耗时曲线口径：avg | median | p90
  timingOpen: false, // 耗时曲线默认折叠，避免占满首屏
  mode: null, // 'live'（本地 node 服务）| 'static'（GitHub Pages 静态快照）
};

// ---------------------------------------------------------------- formatting

const fmtScore = (n) => (n == null || Number.isNaN(n) ? '—' : n.toFixed(3));

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function timeAgo(ms) {
  if (!ms) return '—';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s} 秒前`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分钟前`;
  return `${Math.round(m / 60)} 小时前`;
}

const rowKey = (r) => `${r.userId || ''}|${r.name}`;

const boardById = (id) => state.snapshot?.boards.find((b) => b.id === id) || null;

function diffMap(snap) {
  const map = new Map();
  if (!snap) return map;
  for (const b of snap.boards) map.set(b.id, new Map(b.rows.map((r) => [rowKey(r), r])));
  return map;
}

// ---------------------------------------------------------------- networking

// 数据来源优先级：
//   1) 同源 /api/*（node server.mjs 或 Cloudflare Worker 直接托管这个页面时）
//   2) 远程 Worker（https://board.fireflydle.games/api/*，带 CORS）——GitHub Pages 形态靠它拿实时数据
//   3) 构建时生成的 data/snapshot.json（CI 每 10 分钟刷新，兜底）
const LIVE_ORIGIN = 'https://board.fireflydle.games';
async function fetchSnapshot(force) {
  // GitHub Pages 形态下同源没有 /api，直接跳过那一次必然 404 的探测
  const bases = window.__STATIC_DATA__ ? [LIVE_ORIGIN] : ['', LIVE_ORIGIN];
  if (state.mode !== 'static') {
    for (const base of bases) {
      try {
        const res = await fetch(`${base}/api/snapshot${force ? '?force=1' : ''}`, { cache: 'no-store' });
        const ctype = res.headers.get('content-type') || '';
        if (res.ok && ctype.includes('json')) {
          state.mode = 'live';
          state.apiBase = base;
          return await res.json();
        }
      } catch {
        /* 换下一个来源 */
      }
    }
    state.mode = 'static';
  }
  const res = await fetch(`./data/snapshot.json?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`找不到 data/snapshot.json（HTTP ${res.status}）`);
  return await res.json();
}

function refreshLivePill() {
  if (state.error) return setLive('err', `连接失败：${state.error}`);
  const snap = state.snapshot;
  if (!snap) return;
  const broken = snap.boards.filter((b) => b.error).length;
  if (state.mode === 'static') {
    const gen = Date.parse(snap.generatedAt);
    return setLive(broken ? 'err' : 'ok', `静态快照 · 生成于 ${timeAgo(gen)}${broken ? ` · ${broken} 个榜单异常` : ''}`);
  }
  const stale = snap.boards.filter((b) => b.stale).length;
  setLive(broken ? 'err' : 'ok', `${stale ? '缓存' : '实时'} · ${timeAgo(state.lastSuccess)}`);
}

async function load({ force = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  setLive('loading', '刷新中…');
  $('#refreshBtn').disabled = true;
  try {
    const snap = await fetchSnapshot(force);

    state.prev = state.snapshot;
    state.snapshot = snap;
    state.error = null;
    state.lastSuccess = Date.now();
    computeChanges();
    refreshLivePill();
    render();
  } catch (err) {
    state.error = err.message || String(err);
    refreshLivePill();
    renderBanner();
  } finally {
    state.loading = false;
    $('#refreshBtn').disabled = false;
  }
}

function setLive(kind, text) {
  $('#liveDot').className = `dot ${kind}`;
  $('#liveText').textContent = text;
}

function computeChanges() {
  state.changedKeys = new Set();
  if (!state.prev || !state.snapshot) return;
  const prevIdx = diffMap(state.prev);
  for (const b of state.snapshot.boards) {
    const before = prevIdx.get(b.id);
    if (!before) continue;
    for (const r of b.rows) {
      const old = before.get(rowKey(r));
      const moved = !old || old.rank !== r.rank || old.score !== r.score;
      if (moved) state.changedKeys.add(`${b.id}::${rowKey(r)}`);
    }
  }
}

// ---------------------------------------------------------------- rendering

function render() {
  if (!state.snapshot) return;
  renderSidebar();
  renderHeader();
  renderBanner();

  const board = boardById(state.boardId) || state.snapshot.boards[0];
  if (!board) return;

  const rows = visibleRows(board);
  renderPodium(board, rows);
  renderTable(board, rows);
  renderTiming(board);
}

function renderSidebar() {
  const snap = state.snapshot;
  const q = $('#boardFilter').value.trim().toLowerCase();
  const list = $('#boardList');
  list.textContent = '';

  const boards = snap.boards.filter((b) => !q || b.title.toLowerCase().includes(q));
  $('#boardCount').textContent = `${snap.boards.length} 个`;

  for (const b of boards) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'board-item' + (b.id === state.boardId ? ' active' : '');
    btn.dataset.board = b.id;
    btn.innerHTML = `<span class="lbl"></span><span class="n"></span>`;
    btn.querySelector('.lbl').textContent = b.title;
    btn.querySelector('.n').textContent = b.error ? '!' : b.rows.length;
    btn.title = b.error ? `上游异常：${b.error}` : `${b.rows.length} 条记录`;
    btn.addEventListener('click', () => {
      state.boardId = b.id;
      state.sort = { key: 'rank', dir: 1 };
      state.search = '';
      $('#search').value = '';
      render();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    list.appendChild(btn);
  }
}

function renderHeader() {
  const board = boardById(state.boardId);
  if (!board) return;
  $('#boardTitle').textContent = board.title;

  const bits = [`${board.rows.length} 条记录`];
  if (board.reportedTotal && board.reportedTotal !== board.rows.length) bits.push(`上游 total ${board.reportedTotal}`);
  bits.push(`更新于 ${fmtTime(state.snapshot.generatedAt)}`);
  bits.push(`camp ${state.snapshot.campId}`);
  if (state.mode === 'static') bits.push('静态快照（GitHub Actions 定时更新）');
  if (board.stale) bits.push('（上游抖动，展示上次成功数据）');
  $('#boardMeta').textContent = bits.join(' · ');

  $('#exportBtn').href =
    state.mode === 'static'
      ? '#'
      : `${state.apiBase || ''}/api/export.csv?board=${encodeURIComponent(board.id)}`;
  $('#sourceLink').href = board.source || 'https://open.oceanbase.com/competition/armory';
  $('#campId').textContent = state.snapshot.campId;
}

function renderBanner() {
  const el = $('#banner');
  if (state.error) {
    el.hidden = false;
    el.textContent = `无法连接本地服务：${state.error}。正在重试…`;
    return;
  }
  const board = boardById(state.boardId);
  if (board?.error) {
    el.hidden = false;
    el.textContent = `该榜单上游接口异常：${board.error}。页面展示的是最后一次成功的数据。`;
    return;
  }
  el.hidden = true;
}

function visibleRows(board) {
  const prevIdx = diffMap(state.prev).get(board.id);
  const q = state.search.trim().toLowerCase();

  let rows = board.rows.filter((r) => {
    if (q) {
      const hay = `${r.name} ${r.school} ${r.advisor} ${r.province}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (state.onlyChanged) {
      const before = prevIdx?.get(rowKey(r));
      const changed = !before || before.rank !== r.rank || before.score !== r.score;
      if (!changed) return false;
    }
    return true;
  });

  const { key, dir } = state.sort;
  if (key !== 'rank' || dir !== 1) {
    rows = [...rows].sort((a, b) => {
      let x = a[key];
      let y = b[key];
      if (key === 'rank' || key === 'score') {
        x = x ?? Number.POSITIVE_INFINITY;
        y = y ?? Number.POSITIVE_INFINITY;
        return (x - y) * dir;
      }
      x = String(x || '');
      y = String(y || '');
      return x.localeCompare(y, 'zh-CN') * dir;
    });
  }
  return rows;
}

function renderPodium(board, rows) {
  const el = $('#podium');
  el.textContent = '';
  const pristine = !state.search && !state.onlyChanged && state.sort.key === 'rank' && state.sort.dir === 1;
  if (!pristine || rows.length < 3) return;

  const colors = ['var(--gold)', 'var(--silver)', 'var(--bronze)'];
  rows.slice(0, 3).forEach((r, i) => {
    const card = document.createElement('div');
    card.className = 'pod';
    card.style.setProperty('--c', colors[i]);
    card.innerHTML = `
      <div class="place"><span class="mnum">${i + 1}</span><span>No.${r.rank}</span></div>
      <div class="who"></div>
      <div class="where"></div>
      <div class="sc"></div>`;
    card.querySelector('.who').textContent = r.name;
    card.querySelector('.where').textContent = r.school || r.province || '—';
    card.querySelector('.sc').textContent = fmtScore(r.score);
    card.addEventListener('click', () => openDrawer(board, r));
    el.appendChild(card);
  });
  if (board.kind === 'total') {
    // 总榜卡片补一行说明学校口径
    el.querySelectorAll('.where').forEach((w, i) => {
      if (!w.textContent.trim() || w.textContent === '—') w.textContent = '学校未填';
    });
  }
}

function renderTable(board, rows) {
  const body = $('#boardBody');
  body.textContent = '';
  const maxScore = Math.max(1, ...rows.map((r) => r.score || 0));
  const prevIdx = diffMap(state.prev).get(board.id);

  const frag = document.createDocumentFragment();
  rows.forEach((r) => {
    const tr = document.createElement('tr');
    const key = `${board.id}::${rowKey(r)}`;
    if (state.changedKeys.has(key)) tr.classList.add('row-flash');

    const before = prevIdx?.get(rowKey(r));
    const rankDelta = before ? before.rank - r.rank : 0; // 正数 = 上升
    const scoreDelta = before && before.score != null && r.score != null ? r.score - before.score : 0;

    const rankCls = r.rank <= 3 ? ` rank-${r.rank}` : '';
    const pct = Math.max(2, Math.min(100, ((r.score || 0) / maxScore) * 100));

    let deltaHtml = '<span class="flat">—</span>';
    // 首次加载是基线，没有可比的上一版 → 不显示 NEW
    if (!before && state.prev) deltaHtml = '<span class="badge-new">NEW</span>';
    else if (rankDelta > 0) deltaHtml = `<span class="up">▲${rankDelta}</span>`;
    else if (rankDelta < 0) deltaHtml = `<span class="down">▼${-rankDelta}</span>`;

    let scoreDeltaHtml = '';
    if (scoreDelta > 0) scoreDeltaHtml = `<span class="up">+${fmtScore(scoreDelta)}</span>`;
    else if (scoreDelta < 0) scoreDeltaHtml = `<span class="down">${fmtScore(scoreDelta)}</span>`;

    tr.innerHTML = `
      <td class="col-rank"><span class="rank-badge${rankCls}">${r.rank}</span></td>
      <td class="col-name"><div class="cell-name"></div></td>
      <td class="col-school"><div class="cell-school"></div></td>
      <td class="col-score">
        <div class="score-bar">
          <span class="cell-score"></span>
          <span class="track"><span class="fill" style="width:${pct}%"></span></span>
        </div>
      </td>
      <td class="col-time"><span class="cell-time"></span></td>
      <td class="col-delta"><div class="delta">${deltaHtml}${scoreDeltaHtml}</div></td>`;

    tr.querySelector('.cell-name').textContent = r.name;
    tr.querySelector('.cell-school').textContent = r.school || '—';
    tr.querySelector('.cell-score').textContent = fmtScore(r.score);
    tr.querySelector('.cell-time').textContent = fmtTime(r.bestSubmit);
    tr.addEventListener('click', () => openDrawer(board, r));
    frag.appendChild(tr);
  });

  body.appendChild(frag);
  $('#empty').hidden = rows.length > 0;
}

// ---------------------------------------------------------------- timing chart
//
// 公开接口只给了两个时间戳：gmtCreate（该记录首次提交）与 gmtModified（成绩落库/最后更新）。
// 没有官方的「排队时长」「评测时长」字段，所以：
//   · 端到端耗时 = gmtModified - gmtCreate      → 真实数据
//   · 拆分：把该榜最快的那 20% 耗时（上限 5 分钟）当作纯评测基线，超出的算等待
//     （等待里混有排队 + 多次提交之间的间隔，因此标「推算」）
// 曲线按提交先后排，用滚动窗口平滑，看的是「耗时随时间怎么变」。

const timingCache = new Map();
let timingCacheKey = '';
let svgSeq = 0;

function timingPoints(board) {
  const pts = [];
  for (const r of board.rows) {
    const a = Date.parse(r.bestSubmit);
    const b = Date.parse(r.updated);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const sec = (b - a) / 1000;
    if (sec <= 0) continue;
    pts.push({ t: a, sec });
  }
  pts.sort((x, y) => x.t - y.t);
  return pts;
}

function quantile(arr, q) {
  if (!arr.length) return 0;
  const s = [...arr].sort((x, y) => x - y);
  const i = Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))));
  return s[i];
}

function aggOf(arr, metric) {
  if (!arr.length) return 0;
  if (metric === 'avg') return arr.reduce((s, x) => s + x, 0) / arr.length;
  if (metric === 'p90') return quantile(arr, 0.9);
  return quantile(arr, 0.5);
}

function timingModel(board) {
  const cacheKey = `${timingCacheKey}|${board.id}`;
  if (timingCache.has(cacheKey)) return timingCache.get(cacheKey);

  const pts = timingPoints(board);
  const model = { pts, series: [], baseline: 0, insufficient: pts.length < 3, board };
  if (pts.length) {
    model.baseline = Math.min(quantile(pts.map((p) => p.sec), 0.2), 300);
    for (const p of pts) {
      p.judge = Math.min(p.sec, model.baseline);
      p.queue = Math.max(0, p.sec - p.judge);
    }
    // 滚动窗口：窗口大小随样本量走，保证曲线约 60~120 个点
    const w = Math.max(5, Math.min(80, Math.round(pts.length / 10)));
    const step = Math.max(1, Math.floor(w / 4));
    for (let i = w - 1; i < pts.length; i += step) {
      const win = pts.slice(i - w + 1, i + 1);
      model.series.push({
        t: pts[i].t,
        n: win.length,
        totals: win.map((p) => p.sec),
        judges: win.map((p) => p.judge),
        queues: win.map((p) => p.queue),
      });
    }
    const last = pts[pts.length - 1].t;
    if (!model.series.length || model.series[model.series.length - 1].t !== last) {
      const win = pts.slice(Math.max(0, pts.length - w));
      model.series.push({
        t: last,
        n: win.length,
        totals: win.map((p) => p.sec),
        judges: win.map((p) => p.judge),
        queues: win.map((p) => p.queue),
      });
    }
  }
  timingCache.set(cacheKey, model);
  return model;
}

function fmtDur(sec) {
  if (!Number.isFinite(sec)) return '—';
  if (sec <= 0) return '0';
  if (sec < 1) return `${sec.toFixed(2)} 秒`;
  if (sec < 90) return `${sec.toFixed(sec < 10 ? 1 : 0)} 秒`;
  if (sec < 3600) return `${(sec / 60).toFixed(sec < 600 ? 1 : 0)} 分钟`;
  if (sec < 86400) return `${(sec / 3600).toFixed(1)} 小时`;
  return `${(sec / 86400).toFixed(1)} 天`;
}

function fmtClock(ts) {
  const d = new Date(ts);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 时间轴曲线：浅点=每次评测的实际耗时，粗线=滚动窗口统计
function svgTimeChart(series, raw, { width = 900, height = 168 } = {}) {
  const pad = { l: 58, r: 14, t: 12, b: 24 };
  const iw = width - pad.l - pad.r;
  const ih = height - pad.t - pad.b;
  const t0 = series[0].t;
  const t1 = series[series.length - 1].t;
  const span = Math.max(1, t1 - t0);
  const maxV = Math.max(1e-6, ...series.map((p) => p.total));
  const x = (t) => pad.l + ((t - t0) / span) * iw;
  const y = (v) => pad.t + ih - Math.min(1, v / maxV) * ih;
  const clipId = `clip${(svgSeq += 1)}`;
  const parts = [`<clipPath id="${clipId}"><rect x="${pad.l}" y="${pad.t}" width="${iw}" height="${ih}" /></clipPath>`];

  // 网格 + Y 轴
  for (let k = 0; k <= 3; k += 1) {
    const v = (maxV * k) / 3;
    parts.push(`<line x1="${pad.l}" y1="${y(v).toFixed(1)}" x2="${width - pad.r}" y2="${y(v).toFixed(1)}" class="grid" />`);
    parts.push(`<text x="${pad.l - 8}" y="${(y(v) + 4).toFixed(1)}" class="axis" text-anchor="end">${fmtDur(v)}</text>`);
  }

  // 原始点（超出纵轴范围的直接跳过）
  const dots = raw
    .filter((p) => p.sec <= maxV)
    .map((p) => `<circle cx="${x(p.t).toFixed(1)}" cy="${y(p.sec).toFixed(1)}" r="1.5" class="raw" />`)
    .join('');
  parts.push(`<g clip-path="url(#${clipId})">${dots}</g>`);

  // 堆叠面积：下=等待，上=评测
  const lower = series.map((p) => `${x(p.t).toFixed(1)},${y(p.queue).toFixed(1)}`).join(' L ');
  const upper = series.map((p) => `${x(p.t).toFixed(1)},${y(p.total).toFixed(1)}`).join(' L ');
  parts.push(`<path d="M ${pad.l},${(pad.t + ih).toFixed(1)} L ${lower} L ${x(t1).toFixed(1)},${(pad.t + ih).toFixed(1)} Z" class="area-queue" />`);
  parts.push(`<path d="M ${x(t0).toFixed(1)},${y(series[0].queue).toFixed(1)} L ${upper} L ${x(t1).toFixed(1)},${y(series[series.length - 1].queue).toFixed(1)} Z" class="area-judge" />`);
  parts.push(`<path d="M ${lower}" class="line-queue" />`);
  parts.push(`<path d="M ${upper}" class="line-judge" />`);

  // 平滑点 + tooltip
  for (const p of series) {
    parts.push(
      `<g><circle cx="${x(p.t).toFixed(1)}" cy="${y(p.total).toFixed(1)}" r="2.4" class="dot-judge" />` +
        `<title>${fmtClock(p.t)} 前后 ${p.n} 次\n端到端 ${fmtDur(p.total)}｜等待 ${fmtDur(p.queue)}｜评测 ${fmtDur(p.judge)}</title></g>`,
    );
  }

  // X 轴刻度（按时间均分）
  const ticks = 6;
  for (let k = 0; k < ticks; k += 1) {
    const tt = t0 + (span * k) / (ticks - 1);
    const anchor = k === 0 ? 'start' : k === ticks - 1 ? 'end' : 'middle';
    parts.push(`<text x="${x(tt).toFixed(1)}" y="${height - 7}" class="axis" text-anchor="${anchor}">${fmtClock(tt)}</text>`);
  }

  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" role="img">${parts.join('')}</svg>`;
}

function renderTiming(board) {
  timingCacheKey = state.snapshot?.generatedAt || '';
  const model = timingModel(board);
  const metricLabel = { avg: '平均', median: '中位数', p90: 'P90' }[state.metric];
  const isAggregate = board.kind === 'total';

  const all = model.pts.map((p) => p.sec);
  const judges = model.pts.map((p) => p.judge);
  const queues = model.pts.map((p) => p.queue);
  const cards = [
    ['平均端到端', fmtDur(aggOf(all, 'avg')), `中位 ${fmtDur(quantile(all, 0.5))}`],
    ['等待（推算）', fmtDur(aggOf(queues, state.metric)), '含多次提交间隔'],
    ['评测（推算）', fmtDur(aggOf(judges, state.metric)), '≈最快 20% 耗时'],
    ['样本数', String(model.pts.length), `中位 ${fmtDur(quantile(all, 0.5))}`],
  ];
  $('#timingMetrics').innerHTML = isAggregate
    ? ''
    : cards
        .map(
          ([k, v, hint]) =>
            `<div class="ms"><span class="k">${k}</span><span class="v">${v}</span><span class="h">${hint}</span></div>`,
        )
        .join('');

  $('#timingMeta').textContent = isAggregate
    ? '总榜是队伍级聚合行（首次建记录 → 最后一次更新），差值代表参赛跨度，不是单次评测耗时 —— 请选一个赛道看曲线'
    : `${board.title} · 按提交先后排序 · 滚动窗口 ${model.insufficient ? '—' : model.series[0]?.n || 0} 次 · 口径：${metricLabel}`;

  const chartEl = $('#timingChart');
  if (isAggregate) {
    chartEl.innerHTML =
      '<div class="empty">总榜不画耗时曲线（聚合行的时间差是参赛跨度）。点下方任一赛道即可查看该赛道的耗时曲线。</div>';
  } else if (model.insufficient) {
    chartEl.innerHTML = `<div class="empty">样本不足（${model.pts.length} 条），无法画曲线</div>`;
  } else {
    const series = model.series.map((p) => ({
      t: p.t,
      n: p.n,
      total: aggOf(p.totals, state.metric),
      judge: aggOf(p.judges, state.metric),
      queue: aggOf(p.queues, state.metric),
    }));
    chartEl.innerHTML = svgTimeChart(series, model.pts);
  }

  // 各赛道对比
  const rows = state.snapshot.boards
    .map((b) => {
      const m = timingModel(b);
      const secs = m.pts.map((p) => p.sec);
      return {
        id: b.id,
        title: b.title,
        n: m.pts.length,
        median: quantile(secs, 0.5),
        judge: m.baseline,
        queue: Math.max(0, quantile(secs, 0.5) - m.baseline),
      };
    })
    .filter((r) => r.n > 0)
    .sort((a, b) => b.median - a.median);

  const peak = Math.max(1e-6, ...rows.map((r) => r.median));
  $('#trackTimings').innerHTML = rows
    .map((r) => {
      const w = (r.median / peak) * 100;
      const jw = r.median ? (r.judge / r.median) * 100 : 0;
      return `<button type="button" class="tt-row${r.id === board.id ? ' on' : ''}" data-board="${r.id}">
        <span class="tt-name">${r.title}</span>
        <span class="tt-bar"><span class="tt-fill" style="width:${w.toFixed(1)}%">
          <i class="tt-queue" style="width:${(100 - jw).toFixed(1)}%"></i><i class="tt-judge" style="width:${jw.toFixed(1)}%"></i>
        </span></span>
        <span class="tt-val">${fmtDur(r.median)}<em>${r.n} 条</em></span>
      </button>`;
    })
    .join('');

  $('#trackTimings')
    .querySelectorAll('.tt-row')
    .forEach((el) => {
      el.addEventListener('click', () => {
        state.boardId = el.dataset.board;
        state.sort = { key: 'rank', dir: 1 };
        render();
      });
    });
}

// ---------------------------------------------------------------- drawer

function openDrawer(board, row) {
  state.drawerRow = { board, row };
  const el = $('#drawerBody');
  const snap = state.snapshot;

  const teamBoards = [];
  if (board.kind === 'track') {
    const total = boardById('total');
    const hit = total?.rows.find((r) => (row.userId && r.userId === row.userId) || r.name === row.name);
    if (hit) teamBoards.push({ title: total.title, board, row: hit });
  } else {
    const total = boardById('total');
    teamBoards.push({ title: total.title, row });
  }

  const tracks = [];
  for (const b of snap.boards) {
    if (b.kind !== 'track') continue;
    const hit = b.rows.find((r) => (row.userId && r.userId === row.userId) || r.name === row.name);
    if (hit) tracks.push({ board: b, row: hit });
  }

  const totalRow = board.kind === 'total' ? row : boardById('total')?.rows.find((r) => (row.userId && r.userId === row.userId) || r.name === row.name);
  const localSum = tracks.reduce((s, t) => s + (t.row.score || 0), 0);

  const kvRows = [
    ['学校', row.school || totalRow?.school || '—'],
    ['导师', row.advisor || totalRow?.advisor || '—'],
    ['省份', row.province || totalRow?.province || '—'],
    ['最优提交', fmtTime(row.bestSubmit)],
    ['记录更新', fmtTime(row.updated)],
    ['本榜名次', `No.${row.rank} / ${board.rows.length}`],
  ];

  el.innerHTML = `
    <h3></h3>
    <p class="sub"></p>
    <div class="hero"><span class="big"></span><span class="lbl">该榜成绩</span></div>
    <dl class="kv">${kvRows.map(([k, v]) => `<dt>${k}</dt><dd></dd>`).join('')}</dl>
    <h4 class="section-title">各赛道成绩（${tracks.length} / ${snap.boards.length - 1}）</h4>
    <div class="tracklist"></div>
    <p class="sub" style="margin-top:14px">赛道成绩本地累加参考：<strong>${fmtScore(localSum)}</strong> · ${
      totalRow ? `总榜显示 <strong>${fmtScore(totalRow.score)}</strong>` : '未出现在总榜'
    }。两者口径不同，累加值仅供参考。</p>`;

  el.querySelector('h3').textContent = row.name;
  el.querySelector('.sub').textContent = `${board.title}${row.school ? ' · ' + row.school : ''}`;
  el.querySelector('.hero .big').textContent = fmtScore(row.score);

  const dds = el.querySelectorAll('.kv dd');
  kvRows.forEach(([, v], i) => {
    dds[i].textContent = v;
  });

  const tl = el.querySelector('.tracklist');
  if (!tracks.length) {
    tl.innerHTML = '<div class="row"><span class="t">该队伍没有任何赛道成绩</span><span class="r"></span><span class="s"></span></div>';
  } else {
    tracks.sort((a, b) => (b.row.score || 0) - (a.row.score || 0));
    for (const t of tracks) {
      const div = document.createElement('div');
      div.className = 'row';
      div.innerHTML = '<span class="t"></span><span class="r"></span><span class="s"></span>';
      div.querySelector('.t').textContent = t.board.title;
      div.querySelector('.r').textContent = `No.${t.row.rank} / ${t.board.rows.length}`;
      div.querySelector('.s').textContent = fmtScore(t.row.score);
      tl.appendChild(div);
    }
  }

  $('#drawer').hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeDrawer() {
  $('#drawer').hidden = true;
  state.drawerRow = null;
  document.body.style.overflow = '';
}

// ---------------------------------------------------------------- CSV

const CSV_HEAD = ['rank', 'name', 'school', 'advisor', 'score', 'rawScore', 'bestSubmitTime', 'lastUpdated', 'userId', 'groupId', 'recordId'];

function csvForBoard(board) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [CSV_HEAD.join(',')];
  for (const r of board.rows) {
    lines.push([r.rank, r.name, r.school, r.advisor, r.score, r.rawScore, r.bestSubmit, r.updated, r.userId, r.groupId, r.recordId].map(esc).join(','));
  }
  return '\ufeff' + lines.join('\n') + '\n';
}

// 静态模式下没有 /api/export.csv，前端自己拼 CSV；本地服务模式仍走服务端导出
$('#exportBtn').addEventListener('click', (e) => {
  if (state.mode !== 'static') return;
  const board = boardById(state.boardId);
  if (!board) return;
  e.preventDefault();
  const blob = new Blob([csvForBoard(board)], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `oceanbase-${board.kind === 'total' ? 'total' : 'track-' + board.questionId}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});

// ---------------------------------------------------------------- wiring

$('#refreshBtn').addEventListener('click', () => load({ force: true }));

$('#autoToggle').addEventListener('change', (e) => {
  state.auto = e.target.checked;
  schedule();
});

$('#interval').addEventListener('change', (e) => {
  state.interval = Number(e.target.value);
  schedule();
});

$('#search').addEventListener('input', (e) => {
  state.search = e.target.value;
  render();
});

$('#onlyChanged').addEventListener('change', (e) => {
  state.onlyChanged = e.target.checked;
  render();
});

$('#boardFilter').addEventListener('input', () => renderSidebar());

document.querySelectorAll('th.sortable').forEach((th) => {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    const same = state.sort.key === key;
    // 名次/姓名/学校默认升序；成绩与提交时间默认降序（最高分/最新在前）
    const defaultDir = key === 'score' || key === 'bestSubmit' ? -1 : 1;
    state.sort = same ? { key, dir: state.sort.dir * -1 } : { key, dir: defaultDir };
    document.querySelectorAll('th.sortable').forEach((x) => x.classList.remove('sorted-asc', 'sorted-desc'));
    th.classList.add(state.sort.dir === 1 ? 'sorted-asc' : 'sorted-desc');
    render();
  });
});

$('#timingToggle').addEventListener('click', () => {
  state.timingOpen = !state.timingOpen;
  $('#timingBody').hidden = !state.timingOpen;
  const btn = $('#timingToggle');
  btn.textContent = state.timingOpen ? '收起图表' : '展开图表';
  btn.setAttribute('aria-expanded', String(state.timingOpen));
});

$('#timingMetric').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-metric]');
  if (!btn) return;
  state.metric = btn.dataset.metric;
  $('#timingMetric')
    .querySelectorAll('button')
    .forEach((b) => b.classList.toggle('on', b === btn));
  const board = boardById(state.boardId);
  if (board) renderTiming(board);
});

$('#drawerClose').addEventListener('click', closeDrawer);
$('#drawer').addEventListener('click', (e) => {
  if (e.target.id === 'drawer') closeDrawer();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDrawer();
});

let timer = null;
function schedule() {
  clearTimeout(timer);
  if (!state.auto) return;
  timer = setTimeout(async () => {
    if (!document.hidden) await load();
    schedule();
  }, state.mode === 'static' ? Math.max(state.interval, 60000) : state.interval);
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) load();
});

// 每秒刷新"x 秒前"
setInterval(() => {
  if (!state.loading) refreshLivePill();
}, 1000);

load();
schedule();
