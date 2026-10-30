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
  streaming: false, // WebSocket 推送是否连上
  streamRetries: 0,
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
const FETCH_TIMEOUT_MS = 25000;

// ---------------------------------------------------------------- 访问统计
// 只上报聚合量（PV/榜单切换/CSV 下载/外链点击），不采集任何页面内容；本地开发不上报。
const TRACK_ORIGIN = LIVE_ORIGIN;
const CAN_TRACK = !/^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/.test(location.hostname);

function track(kind, data) {
  if (!CAN_TRACK) return;
  try {
    const body = JSON.stringify({ k: kind, ...(data || {}) });
    if (navigator.sendBeacon) {
      navigator.sendBeacon(`${TRACK_ORIGIN}/api/hit`, new Blob([body], { type: 'text/plain;charset=UTF-8' }));
    } else {
      fetch(`${TRACK_ORIGIN}/api/hit`, { method: 'POST', body, keepalive: true, mode: 'no-cors' });
    }
  } catch {
    /* 统计失败不影响页面 */
  }
}

async function refreshOnline() {
  if (!CAN_TRACK) return;
  try {
    const res = await fetch(`${TRACK_ORIGIN}/api/online`, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (!res.ok) return;
    const d = await res.json();
    const n = Number(d.sockets || 0);
    $('#onlineNum').textContent = String(n);
    $('#onlineBadge').hidden = n <= 0;
  } catch {
    /* 拿不到就不显示 */
  }
}


async function getJson(url) {
  const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const ctype = res.headers.get('content-type') || '';
  if (!res.ok || !ctype.includes('json')) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

// 构建产物里的快照（GitHub Pages 上是 CDN，几百毫秒；本地没有就当作失败）
async function fetchStaticSnapshot() {
  return await getJson(`./data/snapshot.json?t=${Date.now()}`);
}

// 实时接口：同源 → 远程 Worker
async function fetchLiveSnapshot(force) {
  const bases = window.__STATIC_DATA__ ? [LIVE_ORIGIN] : ['', LIVE_ORIGIN];
  let lastErr = null;
  for (const base of bases) {
    try {
      const snap = await getJson(`${base}/api/snapshot${force ? '?force=1' : ''}`);
      state.mode = 'live';
      state.apiBase = base;
      return snap;
    } catch (err) {
      lastErr = err;
    }
  }
  state.mode = state.snapshot?.static ? 'static' : 'offline';
  throw lastErr || new Error('实时接口不可用');
}

function refreshLivePill() {
  if (state.error) {
    if (state.snapshot) {
      return setLive('err', `实时中断（${state.error}）· 显示 ${timeAgo(state.lastSuccess)} 的数据`);
    }
    return setLive('err', `连接失败：${state.error}`);
  }
  const snap = state.snapshot;
  if (!snap) return;
  const broken = snap.boards.filter((b) => b.error).length;
  if (state.mode === 'static') {
    const gen = Date.parse(snap.generatedAt);
    return setLive(broken ? 'err' : 'ok', `静态快照 · 生成于 ${timeAgo(gen)}${broken ? ` · ${broken} 个榜单异常` : ''}`);
  }
  const stale = snap.boards.filter((b) => b.stale).length;
  const push = state.streaming ? '推送中' : stale ? '缓存' : '轮询';
  setLive(broken ? 'err' : 'ok', `${push} · ${timeAgo(state.lastSuccess)}`);
}

function applySnapshot(snap) {
  state.prev = state.snapshot;
  state.snapshot = snap;
  state.error = null;
  state.lastSuccess = Date.now();
  computeChanges();
  refreshLivePill();
  render();
}

async function load({ force = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  setLive('loading', '刷新中…');
  $('#refreshBtn').disabled = true;
  try {
    const snap = await fetchLiveSnapshot(force);
    applySnapshot(snap);
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
  fillPredictBoards();
  renderPredict();
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
      track('board', { b: b.id, t: b.title });
      state.boardId = b.id;
      state.sort = { key: 'rank', dir: 1 };
      state.search = '';
      $('#search').value = '';
      if (b.kind === 'track') $('#predictBoard').value = b.id;
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
    pts.push({ t: a, sec, done: b, name: r.name });
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

const RECENT_WINDOW_MS = 30 * 60 * 1000;

// 评测暂停识别：两次「出分」之间空档过长，就认为平台那段时间没在评测（提交不算数——提交是用户行为）。
// 阈值 = max(60 分钟, 10 × 该榜完成间隔中位数)——跟着各赛道吞吐自适应，宁可漏判也不误判。
const PAUSE_GAP_MIN_MS = 60 * 60 * 1000;
const PAUSE_GAP_FACTOR = 10;
const PAUSE_SPAN_MAX_RATIO = 0.6; // 暂停总时长占比过高说明样本太稀疏，整体不做修正
const OUTLIER_FACTOR = 10; // 修正后仍超过 max(P99, 10 × 中位数) 的当极端异常剔除

function detectPauses(pts) {
  if (pts.length < 8) return [];
  // 只用「完成」事件：提交是用户行为，不能证明平台在评测；只有出分才说明评测在跑。
  const evs = pts.map((p) => p.done).sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < evs.length; i++) gaps.push(evs[i] - evs[i - 1]);
  const threshold = Math.max(PAUSE_GAP_MIN_MS, PAUSE_GAP_FACTOR * quantile(gaps, 0.5));
  const merged = [];
  for (let i = 1; i < evs.length; i++) {
    if (evs[i] - evs[i - 1] < threshold) continue;
    const last = merged[merged.length - 1];
    if (last && evs[i - 1] <= last[1]) last[1] = Math.max(last[1], evs[i]);
    else merged.push([evs[i - 1], evs[i]]);
  }
  const span = evs[evs.length - 1] - evs[0];
  const paused = merged.reduce((sum, [a, b]) => sum + (b - a), 0);
  if (!span || paused / span > PAUSE_SPAN_MAX_RATIO) return [];
  return merged;
}

function overlapMs(a, b, windows) {
  let sum = 0;
  for (const [s0, e0] of windows) {
    const lo = Math.max(a, s0);
    const hi = Math.min(b, e0);
    if (hi > lo) sum += hi - lo;
  }
  return sum;
}

// 扣掉暂停时段、剔除极端样本；返回干净样本、清洗统计
function cleanPoints(rawPts) {
  const pauses = detectPauses(rawPts);
  let pausedN = 0; // 有多少条记录跨了暂停时段
  let deductSec = 0; // 这些记录总共被扣掉多少时间
  for (const p of rawPts) {
    p.rawSec = p.sec;
    if (!pauses.length) continue;
    const ov = overlapMs(p.t, p.done, pauses);
    if (ov > 0) {
      p.pausedSec = ov / 1000;
      p.sec = Math.max(0, p.sec - ov / 1000);
      deductSec += ov / 1000;
      pausedN += 1;
    }
  }
  const positives = rawPts.map((p) => p.sec).filter((v) => v > 0);
  const med = quantile(positives, 0.5) || 0;
  const fence = Math.max(quantile(positives, 0.99), med * OUTLIER_FACTOR, 60);
  const pts = rawPts.filter((p) => p.sec > 0 && p.sec <= fence);
  // 只有真正影响到留存样本的暂停窗口才画出来，避免图上铺满无意义的灰条
  const drawn = pauses.filter(([a, b]) => pts.some((p) => p.t < b && p.done > a));
  return {
    pts,
    drawnPauses: drawn,
    cleanup: {
      rawN: rawPts.length,
      keptN: pts.length,
      excludedN: rawPts.length - pts.length,
      pausedN,
      deductSec,
      pauseWin: pauses.length,
      pauseSec: pauses.reduce((sum, [a, b]) => sum + (b - a) / 1000, 0),
      fence,
    },
  };
}

function timingModel(board) {
  const cacheKey = `${timingCacheKey}|${board.id}`;
  if (timingCache.has(cacheKey)) return timingCache.get(cacheKey);

  const rawPts = timingPoints(board);
  const { pts, cleanup, drawnPauses } = cleanPoints(rawPts);
  const model = { pts, cleanup, pauses: drawnPauses, latest: null, series: [], baseline: 0, insufficient: pts.length < 3, board };
  // 最近一次「有更新」的记录（完成时间最晚的那条），用于展示最新评测的提交时间
  for (const p of pts) {
    const done = p.done;
    if (model.latest && done <= model.latest.done) continue;
    model.latest = { name: p.name, submit: p.t, done, sec: p.sec, pausedSec: p.pausedSec || 0 };
  }
  if (!model.latest) {
    for (const r of board.rows) {
      const done = Date.parse(r.updated);
      if (!Number.isFinite(done)) continue;
      if (model.latest && done <= model.latest.done) continue;
      const submit = Date.parse(r.bestSubmit);
      model.latest = {
        name: r.name,
        submit: Number.isFinite(submit) ? submit : null,
        done,
        sec: Number.isFinite(submit) ? (done - submit) / 1000 : null,
      };
    }
  }
  if (pts.length) {
    // 单次评测时长（T）估计：
    // ① 队列基本空的样本（提交时在途 ≤1、且区间不跨停摆）≈ 真实评测开销 → 取中位数
    // ② 样本不足时用「完成节拍 × 隐含并发槽位」推断（队列饱和时间隔 = T ÷ 并发，同集群实测 2~5 槽，取 2.5）
    const idleSecs = [];
    for (const p of pts) {
      const inflight = pts.filter((o) => o !== p && o.t <= p.t && o.done > p.t).length;
      const overl = model.pauses.length ? overlapMs(p.t, p.done, model.pauses) : 0;
      if (inflight <= 1 && overl < 60 * 1000) idleSecs.push(p.sec);
    }
    const doneTimes = pts.map((p) => p.done).sort((a, b) => a - b);
    const cgaps = [];
    for (let i = 1; i < doneTimes.length; i++) {
      const a = doneTimes[i - 1];
      const b2 = doneTimes[i];
      if (model.pauses.length && overlapMs(a, b2, model.pauses) > 0) continue;
      cgaps.push((b2 - a) / 1000);
    }
    const cadence = cgaps.length >= 5 ? quantile(cgaps, 0.5) : 0;
    const medAll = quantile(pts.map((p) => p.sec), 0.5) || 0;
    if (idleSecs.length >= 20) {
      model.baseline = quantile(idleSecs, 0.5);
      model.judge = { kind: 'measured', value: model.baseline, samples: idleSecs.length, cadence, c: cadence > 0 ? model.baseline / cadence : null };
    } else if (cadence > 0) {
      const SLOTS = 2.5;
      model.baseline = Math.min(cadence * SLOTS, medAll * 0.9);
      model.judge = { kind: 'inferred', value: model.baseline, samples: idleSecs.length, cadence, c: SLOTS };
    } else {
      model.baseline = Math.min(quantile(pts.map((p) => p.sec), 0.2), 300);
      model.judge = { kind: 'fallback', value: model.baseline, samples: idleSecs.length, cadence: 0, c: null };
    }
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
    // 最近窗口：默认近 30 分钟；样本太稀疏时退回最后 20 条
    let recent = pts.filter((p) => last - p.t <= RECENT_WINDOW_MS);
    if (recent.length < 5) recent = pts.slice(Math.max(0, pts.length - 20));
    model.recent = { pts: recent, from: recent.length ? recent[0].t : last, to: last };
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

function escHtml(v) {
  return String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function fmtClock(ts) {
  const d = new Date(ts);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 时间轴曲线：浅点=每次评测的实际耗时，粗线=滚动窗口统计
// 纵轴用「人类友好」的刻度步长（秒 → 分 → 小时 → 天），避免 13.9 小时 / 1.2 天 这种读数
const HUMAN_STEPS = [
  1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 432000,
];

function niceScale(maxV, count = 4) {
  if (!(maxV > 0)) return { max: 1, step: 1 };
  for (const s of HUMAN_STEPS) {
    if (s * count >= maxV) return { max: s * count, step: s };
  }
  const top = HUMAN_STEPS[HUMAN_STEPS.length - 1];
  return { max: top * count, step: top };
}

function svgTimeChart(series, raw, { width = 900, height = 182, recent = null, latest = null, pauses = [] } = {}) {
  const pad = { l: 58, r: 14, t: 12, b: 24 };
  const iw = width - pad.l - pad.r;
  const ih = height - pad.t - pad.b;
  const t0 = series[0].t;
  const t1 = series[series.length - 1].t;
  const span = Math.max(1, t1 - t0);
  const peak = Math.max(1e-6, ...series.map((p) => p.total));
  const { max: maxV, step: yStep } = niceScale(peak, 4);
  const x = (t) => pad.l + ((t - t0) / span) * iw;
  const y = (v) => pad.t + ih - Math.min(1, v / maxV) * ih;
  const clipId = `clip${(svgSeq += 1)}`;
  const parts = [`<clipPath id="${clipId}"><rect x="${pad.l}" y="${pad.t}" width="${iw}" height="${ih}" /></clipPath>`];

  // 评测暂停时段（这段时间平台没有任何提交/完成，耗时统计里已把重叠部分扣掉）
  for (const [s0, e0] of pauses) {
    const bx = Math.max(pad.l, x(s0));
    const bw = Math.min(width - pad.r, x(e0)) - bx;
    if (bw <= 0.5) continue;
    parts.push(
      `<rect x="${bx.toFixed(1)}" y="${pad.t}" width="${bw.toFixed(1)}" height="${ih}" class="pause-band"><title>评测暂停 ${fmtClock(s0)} → ${fmtClock(e0)}（${fmtDur((e0 - s0) / 1000)}）</title></rect>`,
    );
  }

  // 最近窗口底色
  if (recent && recent.to > recent.from) {
    const bx = Math.max(pad.l, x(recent.from));
    parts.push(`<rect x="${bx.toFixed(1)}" y="${pad.t}" width="${(width - pad.r - bx).toFixed(1)}" height="${ih}" class="recent-band" />`);
  }

  // 网格 + Y 轴
  // 纵轴统一单位，避免 18 小时 / 1.0 天 混排
  const yUnit = yStep >= 86400 ? 86400 : yStep >= 3600 ? 3600 : yStep >= 60 ? 60 : 1;
  const ySuffix = { 86400: ' 天', 3600: ' 小时', 60: ' 分钟', 1: ' 秒' }[yUnit];
  const yLabel = (v) => (v === 0 ? '0' : `${Number((v / yUnit).toFixed(v / yUnit < 10 ? 1 : 0))}${ySuffix}`);
  for (let k = 0; k <= 4; k += 1) {
    const v = yStep * k;
    parts.push(`<line x1="${pad.l}" y1="${y(v).toFixed(1)}" x2="${width - pad.r}" y2="${y(v).toFixed(1)}" class="grid" />`);
    parts.push(`<text x="${pad.l - 8}" y="${(y(v) + 4).toFixed(1)}" class="axis" text-anchor="end">${yLabel(v)}</text>`);
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

  // 最新一次评测的提交时间：末端竖虚线
  if (latest && latest.submit && latest.submit >= t0 && latest.submit <= t1) {
    const lx = x(latest.submit).toFixed(1);
    parts.push(`<line x1="${lx}" y1="${pad.t}" x2="${lx}" y2="${(pad.t + ih).toFixed(1)}" class="latest-line" />`);
    parts.push(
      `<text x="${(Number(lx) - 6).toFixed(1)}" y="${(pad.t + 9).toFixed(1)}" class="latest-label" text-anchor="end">最新评测 ${fmtClock(latest.submit)}</text>`,
    );
  }

  // 最近平均等待参考线
  if (recent && recent.queue >= 0 && recent.queue <= maxV) {
    const ry = y(recent.queue).toFixed(1);
    parts.push(`<line x1="${pad.l}" y1="${ry}" x2="${width - pad.r}" y2="${ry}" class="recent-line" />`);
    parts.push(
      `<text x="${width - pad.r - 4}" y="${(Number(ry) - 4).toFixed(1)}" class="recent-label" text-anchor="end">最近等待 ${fmtDur(recent.queue)}</text>`,
    );
  }

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
  const rec = model.recent?.pts || [];
  const recentQueue = rec.length ? aggOf(rec.map((p) => p.queue), state.metric) : 0;
  const recentTotal = rec.length ? aggOf(rec.map((p) => p.sec), state.metric) : 0;
  const recentSpan = rec.length > 1 ? (rec[rec.length - 1].t - rec[0].t) / 1000 : 0;
  const jl = model.judge || {};
  const judgeLabel = jl.kind === 'measured' ? `评测（实测 ${jl.samples} 条）` : jl.kind === 'inferred' ? '评测（推断 · 节拍×2.5）' : '评测（推算）';
  const judgeTip = jl.kind === 'measured'
    ? `队列基本空的 ${jl.samples} 条样本，单次评测中位 ${fmtDur(jl.value)}${jl.c ? `；完成节拍 ${fmtDur(jl.cadence)}，隐含 ${jl.c.toFixed(1)} 个并发槽` : ''}。`
    : jl.kind === 'inferred'
      ? `无排队样本只有 ${jl.samples} 条，改用完成节拍 ${fmtDur(jl.cadence)} × 2.5 个并发槽推断（队列饱和时间隔 = 单次时长 ÷ 并发数）。`
      : '样本不足，按最快 20% 耗时粗略估计。';
  const dur = (v) => (v == null || !Number.isFinite(v) ? '—' : fmtDur(v));

  // ---------- 1. 最新一次评测：一句话 ----------
  const lt = model.latest;
  let latestHtml;
  if (!lt) {
    latestHtml = '<span class="tl-badge">最新一次评测</span><span class="tl-main">暂无可用时间戳</span>';
  } else if (isAggregate) {
    latestHtml =
      '<span class="tl-badge">最近更新</span>' +
      `<span class="tl-main"><b>${escHtml(lt.name)}</b> ${lt.submit ? `${fmtClock(lt.submit)} 首次提交` : '提交时间未知'} → ${fmtClock(lt.done)} 最后更新</span>` +
      `<span class="tl-tail">参赛跨度 <b>${dur(lt.sec)}</b> · ${timeAgo(lt.done)}</span>`;
  } else {
    latestHtml =
      '<span class="tl-badge">最新一次评测</span>' +
      `<span class="tl-main"><b>${escHtml(lt.name)}</b> ${lt.submit ? `${fmtClock(lt.submit)} 提交` : '提交时间未知'} → ${fmtClock(lt.done)} 完成</span>` +
      `<span class="tl-tail">用时 <b>${dur(lt.sec)}</b> · ${timeAgo(lt.done)}</span>`;
  }
  $('#timingLatest').innerHTML = latestHtml;

  // ---------- 2. 两组数字：最近 vs 全榜 ----------
  const figs = [];
  if (isAggregate) {
    const spans = [];
    for (const r of board.rows) {
      const a = Date.parse(r.bestSubmit);
      const b = Date.parse(r.updated);
      if (Number.isFinite(a) && Number.isFinite(b) && b > a) spans.push((b - a) / 1000);
    }
    figs.push(`<div class="tl-group">
      <span class="tl-glabel">全榜 · ${board.rows.length} 支队伍</span>
      <div class="tl-figs">
        <div class="f"><b>${dur(quantile(spans, 0.5))}</b><span>中位参赛跨度</span></div>
        <div class="f"><b>${dur(aggOf(spans, 'avg'))}</b><span>平均参赛跨度</span></div>
        <div class="f"><b>${spans.length}</b><span>有跨度数据的队伍</span></div>
      </div></div>`);
  } else {
    const recentNote = rec.length
      ? `最近 ${rec.length} 条${recentSpan > 0 ? ` · 跨 ${fmtDur(recentSpan)}` : ''}`
      : '样本不足';
    figs.push(`<div class="tl-group hot">
      <span class="tl-glabel">${recentNote} · 口径：${metricLabel}${model.cleanup && model.cleanup.pausedN ? '（已扣暂停）' : ''}</span>
      <div class="tl-figs">
        <div class="f"><b>${fmtDur(recentQueue)}</b><span>等待</span></div>
        <div class="f"><b>${fmtDur(recentTotal)}</b><span>端到端</span></div>
      </div></div>`);
    figs.push(`<div class="tl-group">
      <span class="tl-glabel">全榜 · ${model.pts.length} 条有效记录${model.cleanup && model.cleanup.excludedN ? `（原始 ${model.cleanup.rawN} 条）` : ''} · 口径：${metricLabel}${model.cleanup && model.cleanup.pausedN ? '（已扣暂停）' : ''}</span>
      <div class="tl-figs">
        <div class="f"><b>${fmtDur(aggOf(all, 'avg'))}</b><span>端到端（中位 ${fmtDur(quantile(all, 0.5))}）</span></div>
        <div class="f"><b>${fmtDur(aggOf(queues, state.metric))}</b><span>等待（端到端 − 评测）</span></div>
        <div class="f" title="${judgeTip}"><b>${fmtDur(aggOf(judges, state.metric))}</b><span>${judgeLabel}</span></div>
      </div></div>`);
  }
  $('#timingFigures').innerHTML = figs.join('');

  const cl = model.cleanup;
  let cleanNote = '';
  if (!isAggregate && cl) {
    const parts2 = [];
    if (cl.excludedN) parts2.push(`剔除 ${cl.excludedN} 条极端异常（> ${fmtDur(cl.fence)}）`);
    if (cl.pauseWin) {
      parts2.push(
        cl.pausedN
          ? `发现 ${cl.pauseWin} 段评测暂停（共 ${fmtDur(cl.pauseSec)}），影响 ${cl.pausedN} 条记录（重叠部分已扣除）`
          : `发现 ${cl.pauseWin} 段评测暂停（共 ${fmtDur(cl.pauseSec)}），不影响已有样本`,
      );
    } else {
      parts2.push('未发现评测暂停时段');
    }
    cleanNote = parts2.join(' · ');
  }
  $('#timingMeta').textContent = isAggregate
    ? '总榜按队伍聚合（首次提交 → 最后更新），要看单次评测请点左侧赛道'
    : `按提交先后排序 · 曲线滚动 ${model.insufficient ? '—' : model.series[0]?.n || 0} 次 · 口径：${metricLabel} · ${cleanNote}`;
  $('#timingMeta').title = isAggregate
    ? ''
    : '评测暂停 = 整条赛道连续 max(60 分钟, 10×事件间隔中位数) 内没有任何提交或完成；跨暂停的那部分耗时已扣除。极端异常 = 修正后仍超过 max(P99, 10×中位数)。';

  // 总榜没有单次评测曲线：隐藏口径切换与展开按钮
  $('#timingMetric').hidden = isAggregate;
  $('#timingToggle').hidden = isAggregate;
  $('#timingBody').hidden = isAggregate || !state.timingOpen;

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
    chartEl.innerHTML = svgTimeChart(series, model.pts, {
      recent: { from: model.recent?.from || 0, to: model.recent?.to || 0, queue: recentQueue },
      latest: model.latest,
      pauses: model.pauses || [],
    });
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
        recentQueue: m.recent?.pts?.length ? aggOf(m.recent.pts.map((p) => p.queue), state.metric) : 0,
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
        <span class="tt-val">${fmtDur(r.median)}<em>${r.n} 条 · 近 ${fmtDur(r.recentQueue)}</em></span>
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

// ---------------------------------------------------------------- 出分预测
// 出分队列有三种形态，分别建模：
//  · 稳态（饱和 / 缩短 / 变长）：队头的「提交时刻」随钟表匀速前进，
//    推进速率 r = Δ队头提交时刻 / Δ时钟。r≈1 表示系统满负荷，队头与当前时间同步推进；
//    r>1 说明队列正在被快速消化（回填），r<1 说明队列在变长。
//    T 排在队头 F 之后时，等待 (T − F) / r 小时后开跑，再加单次评测时间。
//  · 批量作业：出分挤在少数几个窗口，中间几十小时零出分，线性外推无意义 → 给下一次窗口。
const PREDICT_WINDOWS_H = [6, 24, 72];

function predictBursts(pts) {
  // 把相隔 ≤10 分钟的完成时刻合并成一批（批量回填会成批出分）
  const out = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && p.done - last.done <= 10 * 60e3) {
      last.done = p.done;
      last.n += 1;
    } else {
      out.push({ start: p.done, done: p.done, n: 1 });
    }
  }
  return out;
}

function predictQueue(board) {
  if (!board || board.kind !== 'track') return null;
  const pts = timingPoints(board).slice().sort((a, b) => a.done - b.done);
  if (!pts.length) return null;
  const now = Date.now();

  // 推进速率：优先用最近 6 小时的出分样本，样本不足再放宽到 24 / 72 小时
  let win = null;
  for (const h of PREDICT_WINDOWS_H) {
    const set = pts.filter((p) => p.done >= now - h * 3600e3);
    if (set.length < 5) continue;
    const front = set[set.length - 1];
    const back = set[0];
    const dClockH = (front.done - back.done) / 3600e3;
    if (dClockH < 0.5) continue; // 全挤在同一时刻，量不出速率
    const rate = (front.t - back.t) / (dClockH * 3600e3);
    if (!Number.isFinite(rate) || rate <= 0.05 || rate > 80) continue;
    win = { front, back, rate, spanH: h, samples: set.length, cadenceSec: (dClockH * 3600) / set.length };
    break;
  }

  const bursts = predictBursts(pts);
  const durs = pts.slice(-60).map((p) => p.sec);
  return {
    n: pts.length,
    win,
    front: win ? win.front : pts[pts.length - 1],
    rate: win ? win.rate : null,
    bursts,
    lastBurst: bursts[bursts.length - 1] || null,
    medDur: quantile(durs, 0.5),
    p90Dur: quantile(durs, 0.9),
    windows: [...new Set(bursts.slice(-12).map((x) => new Date(x.start).getHours()))].sort((a, b) => a - b),
  };
}

function nextWindow(hours, afterMs) {
  let best = null;
  for (let day = 0; day < 4; day++) {
    for (const h of hours) {
      const d = new Date(afterMs);
      d.setHours(h, 0, 0, 0);
      d.setDate(d.getDate() + day);
      const ms = d.getTime();
      if (ms < afterMs - 30 * 60e3) continue;
      if (best == null || ms < best) best = ms;
    }
  }
  return best;
}

function rateLabelOf(rate) {
  if (rate == null) return '速率不可测';
  if (rate >= 2.5) return '回填中（快速消化积压）';
  if (rate > 1.25) return '积压被消化（队列在缩短）';
  if (rate >= 0.8) return '饱和（队头与时钟同步）';
  return '积压在增长（队列在变长）';
}

function predictEta(board, submitMs) {
  const now = Date.now();
  const q = predictQueue(board);
  if (!q) return { kind: 'none', q: null };
  const tm = timingModel(board);
  const judgeKnown = tm.judge?.kind === 'measured';
  const judgeValue = Number.isFinite(tm.judge?.value) ? tm.judge.value : null;
  const judgeUsable = judgeKnown || (judgeValue != null && judgeValue >= 15);
  const judgeSec = judgeUsable ? judgeValue : 0;
  const judgeMs = judgeSec * 1000;

  if (!q.win) {
    // 批量作业：给「你提测之后最近的一个出分窗口」
    const from = Math.max(now, submitMs);
    const hours = q.windows.length ? q.windows : [new Date(q.front.done).getHours()];
    const w = nextWindow(hours, from);
    return {
      kind: 'batch',
      q,
      judgeSec,
      judgeKnown,
      etaMs: w,
      earliest: w != null ? w - 45 * 60e3 : null,
      latest: w != null ? w + 105 * 60e3 : null,
      fallbackMs: submitMs + q.medDur * 1000,
      hours,
    };
  }
  // 队头此刻的「提交时刻」位置：最新出分那条的提交时刻 + 速率 × 它完成至今的钟表时间
  const r = q.rate;
  const frontPos = q.front.t + r * (now - q.front.done);
  // 快赛道（端到端中位 ≤15 分钟）：队列几乎不排队，直接按端到端分布给时间，不必走排队外推
  if (q.medDur <= 15 * 60) {
    return {
      kind: 'fast',
      q,
      judgeSec,
      judgeKnown,
      frontPos,
      etaMs: submitMs + q.medDur * 1000,
      earliest: submitMs + Math.max(5, q.medDur * 0.5) * 1000,
      latest: submitMs + Math.max(60, q.p90Dur) * 1000,
    };
  }
  if (submitMs <= frontPos) {
    // 提交时刻已经在队头之前：队列应该已经越过你
    return { kind: 'overdue', q, judgeSec, judgeKnown, frontPos, etaMs: now, earliest: null, latest: null };
  }
  const spread = r >= 2.5 ? 0.5 : 0.3; // 回填速率不稳定，区间放宽
  return {
    kind: 'queue',
    q,
    judgeSec,
    judgeKnown,
    frontPos,
    etaMs: now + (submitMs - frontPos) / r + judgeMs,
    earliest: now + (submitMs - frontPos) / (r * (1 + spread)) + judgeMs,
    latest: now + (submitMs - frontPos) / (r * (1 - spread)) + judgeMs,
  };
}

function renderPredict() {
  const out = $('#predictOut');
  if (!out || !state.snapshot) return;
  const sel = $('#predictBoard');
  const timeInput = $('#predictTime');
  if (!sel.options.length) return;
  if (!timeInput.value) {
    const d = new Date();
    d.setSeconds(0, 0);
    timeInput.value = new Date(d.getTime() - d.getTimezoneOffset() * 60e3).toISOString().slice(0, 16);
  }
  const board = boardById(sel.value);
  const src = $('#predictSource');
  if (board) {
    src.hidden = false;
    src.href = `https://open.oceanbase.com/train/detail/21?questionId=${board.questionId}`;
  }
  const submitMs = new Date(timeInput.value).getTime();
  if (!board || !Number.isFinite(submitMs)) {
    out.innerHTML = '<p class="pr-note">选一个赛道并填提测时间。</p>';
    return;
  }
  const r = predictEta(board, submitMs);
  if (r.kind === 'none') {
    out.innerHTML = '<p class="pr-note">该赛道还没有可用的提交/完成时间戳，无法估算。</p>';
    return;
  }
  const q = r.q;
  let facts;
  let head;
  let note;

  if (r.kind === 'fast') {
    const past = r.etaMs <= Date.now();
    facts = [
      `队头已推进到 ${fmtClock(r.frontPos)}（基本不排队）`,
      `端到端中位 ${fmtDur(q.medDur)}`,
      `P90 ${fmtDur(q.p90Dur)}`,
      `记录数 ${q.n}`,
    ];
    head =
      '<div class="pr-main"><span class="pr-label ok">预计出分</span>' +
      `<span class="pr-eta">${fmtClock(r.etaMs)}</span>` +
      `<span class="pr-sub">${past ? '按历史耗时，此刻应该已经有分了' : `提交后约 ${fmtDur(q.medDur)}`} · 通常 ${fmtDur(Math.max(5, q.medDur * 0.5))} – ${fmtDur(Math.max(60, q.p90Dur))} 内出分</span></div>`;
    note =
      `这个赛道基本随提随出：端到端中位 <b>${fmtDur(q.medDur)}</b>、P90 <b>${fmtDur(q.p90Dur)}</b>（${q.n} 条记录），` +
      '排队几乎可以忽略，所以直接用你自己提测时刻加上正常耗时来估。若已经超过这个时间还没出分，八成是提测没成功或代码/环境有问题。';
  } else if (r.kind === 'overdue') {
    facts = [
      `队头提交 ${fmtClock(q.front.t)}`,
      `队头已推进到 ${fmtClock(r.frontPos)}`,
      `最新出分 ${fmtClock(q.front.done)}`,
      `记录数 ${q.n}`,
    ];
    head =
      '<div class="pr-main"><span class="pr-label warn">应该已经出分</span>' +
      '<span class="pr-eta">早已越过</span>' +
      '<span class="pr-sub">你的提测时刻早于当前队头，队列已经处理到这里之后了</span></div>';
    note =
      `该赛道最新出分的那条提交于 <b>${fmtClock(q.front.t)}</b>（${timeAgo(q.front.done)}完成），按当前速率队头已推进到 <b>${fmtClock(r.frontPos)}</b>，你的 ${fmtClock(submitMs)} 在它之前。` +
      '如果榜上还没有你的记录，说明这次提交可能没被受理；或者已经出分但分数没变（榜单只保留每人最优记录）。';
  } else if (r.kind === 'batch') {
    const winText = r.hours.map((h) => `${String(h).padStart(2, '0')}:00`).join(' / ');
    facts = [
      `最近一批出分 ${q.lastBurst ? fmtClock(q.lastBurst.done) : '—'}`,
      q.lastBurst ? `该批 ${q.lastBurst.n} 条` : '批次未知',
      `端到端中位 ${fmtDur(q.medDur)}`,
      `记录数 ${q.n}`,
    ];
    head =
      '<div class="pr-main"><span class="pr-label batch">批量作业 · 下一次出分窗口</span>' +
      `<span class="pr-eta">${r.etaMs ? fmtClock(r.etaMs) : '—'}</span>` +
      (r.etaMs
        ? `<span class="pr-sub">区间 ${fmtClock(r.earliest)} – ${fmtClock(r.latest)}</span>`
        : '<span class="pr-sub">按历史窗口推算不出</span>') +
      '</div>' +
      `<p class="pr-fallback">参考：该赛道历史端到端中位 <b>${fmtDur(q.medDur)}</b>，若按此算约 ${fmtClock(r.fallbackMs)}</p>`;
    note =
      `这个赛道近 3 天只出了 <b>${q.n}</b> 条，出分集中在 ${winText} 这几个窗口、中间成片零出分——` +
      '属于批量/定时触发，不能按推进速率外推。上表取「你提测时刻之后最近的窗口」，仅供参考。';
  } else {
    const waitH = (r.etaMs - submitMs) / 3600e3;
    facts = [
      `队头已推进到 ${fmtClock(r.frontPos)}`,
      `当前积压 ${fmtDur((Date.now() - r.frontPos) / 1000)}`,
      `推进速率 ${q.rate.toFixed(2)}× · ${rateLabelOf(q.rate)}`,
      `近期平均出分间隔 ${fmtDur(q.win.cadenceSec)}`,
      r.judgeSec ? `单次评测 ≈ ${fmtDur(r.judgeSec)}${r.judgeKnown ? '' : '（推断）'}` : '单次评测时长未知',
    ];
    head =
      '<div class="pr-main"><span class="pr-label ok">预计出分</span>' +
      `<span class="pr-eta">${fmtClock(r.etaMs)}</span>` +
      `<span class="pr-sub">提交后约 ${waitH >= 0.1 ? `${waitH.toFixed(1)} 小时` : `${Math.max(1, Math.round(waitH * 60))} 分钟`} · 区间 ${fmtClock(r.earliest)} – ${fmtClock(r.latest)}</span></div>`;
    note =
      `按队列推进推算：队头（最新出分那条）提交于 <b>${fmtClock(q.front.t)}</b>，最近 ${q.win.spanH} 小时内队列的「提交时刻」以 ` +
      `<b>${q.rate.toFixed(2)}×</b> 的速率随钟表前进（${rateLabelOf(q.rate)}；1.00× = 队头与当前时间同步，系统满负荷），因此此刻队头已推进到 ${fmtClock(r.frontPos)}。` +
      `你的 ${fmtClock(submitMs)} 还排在队头之后 ${fmtDur((submitMs - r.frontPos) / 1000)} 的提交量里，除以速率即等待时长` +
      (r.judgeSec ? `，再加单次评测 ≈ ${fmtDur(r.judgeSec)}。` : '（该赛道拿不到空载样本，无法单列评测时长，暂按队列等待计）。') +
      (q.rate >= 1.25
        ? '注意：队列正在被快速消化，一旦积压清空，实际出分会早于这个估计。'
        : q.rate < 0.8
          ? '注意：队列在变长，实际出分可能晚于这个估计。'
          : '');
  }
  out.innerHTML =
    head +
    `<div class="pr-facts">${facts.map((f) => `<span>${escHtml(f)}</span>`).join('')}</div>` +
    `<p class="pr-note">${note}</p>`;
}

function fillPredictBoards() {
  const sel = $('#predictBoard');
  if (!sel || !state.snapshot) return;
  const boards = state.snapshot.boards.filter((b) => b.kind === 'track');
  const keep = sel.value;
  sel.textContent = '';
  for (const b of boards) {
    const o = document.createElement('option');
    o.value = b.id;
    o.textContent = b.title;
    sel.appendChild(o);
  }
  if (boards.some((b) => b.id === keep)) sel.value = keep;
  else if (boards.some((b) => b.id === state.boardId)) sel.value = state.boardId;
  else if (!sel.value && boards.length) sel.value = boards[0].id;
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
  track('csv', { b: state.boardId });
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

$('#sourceLink').addEventListener('click', () => track('out', { b: state.boardId }));

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

// ---- 出分预测面板 ----
$('#predictBtn').addEventListener('click', () => {
  const b = boardById($('#predictBoard').value);
  track('predict', { b: $('#predictBoard').value, t: b?.title || '' });
  renderPredict();
});
$('#predictBoard').addEventListener('change', () => renderPredict());
$('#predictTime').addEventListener('change', () => renderPredict());
$('#predictTime').addEventListener('input', () => renderPredict());
$('#predictNow').addEventListener('click', () => {
  const d = new Date();
  d.setSeconds(0, 0);
  $('#predictTime').value = new Date(d.getTime() - d.getTimezoneOffset() * 60e3).toISOString().slice(0, 16);
  renderPredict();
});

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
  btn.textContent = state.timingOpen ? '收起曲线' : '展开曲线';
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

// 推送帧是 gzip 过的二进制（Worker 侧手动压的），字符串帧也兼容
async function decodeFrame(data) {
  if (typeof data === 'string') return JSON.parse(data);
  const buf = data instanceof Blob ? await data.arrayBuffer() : data;
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return await new Response(stream).json();
}

// Worker 的 Durable Object 会主动推最新快照过来；连不上就退回轮询
let socket = null;
function startStream() {
  // 本地 node dev server 没有 Durable Object，跳过 WS
  if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) return;
  if (state.streamRetries > 3) return;
  const origin = window.__STATIC_DATA__ ? LIVE_ORIGIN : location.origin;
  const url = `${origin.replace(/^http/, 'ws')}/api/stream`;
  try {
    socket = new WebSocket(url);
  } catch {
    state.streamRetries = 4;
    return;
  }
  socket.addEventListener('open', () => {
    state.streaming = true;
    state.streamRetries = 0;
    state.mode = 'live';
    refreshLivePill();
    refreshOnline(); // 连上之后在线人数才有意义
  });
  socket.addEventListener('message', async (ev) => {
    try {
      const snap = await decodeFrame(ev.data);
      if (snap && Array.isArray(snap.boards)) applySnapshot(snap);
    } catch {
      /* 忽略坏包 */
    }
  });
  socket.addEventListener('close', () => {
    state.streaming = false;
    state.streamRetries += 1;
    refreshLivePill();
    setTimeout(startStream, 5000);
  });
  socket.addEventListener('error', () => {
    state.streaming = false;
  });
}

let timer = null;
function schedule() {
  clearTimeout(timer);
  if (!state.auto) return;
  // 有推送时轮询只做兜底（60 秒一次），没有推送才按用户选的间隔轮询
  const interval = state.streaming
    ? 60000
    : state.mode === 'static'
      ? Math.max(state.interval, 60000)
      : state.interval;
  timer = setTimeout(async () => {
    if (!document.hidden && !state.streaming) await load();
    schedule();
  }, interval);
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) load();
});

// 每秒刷新"x 秒前"
setInterval(() => {
  if (!state.loading) refreshLivePill();
}, 1000);

// 启动顺序：先用构建快照把首屏铺满（快），再去连实时接口（Worker 冷启可能要 10 秒）
async function bootstrap() {
  try {
    const snap = await fetchStaticSnapshot();
    state.snapshot = snap;
    if (window.__STATIC_DATA__) state.mode = 'static';
    state.lastSuccess = Date.now();
    state.error = null;
    computeChanges();
    refreshLivePill();
    render();
  } catch {
    /* 没有静态快照（本地开发常见），直接等实时 */
  }
  await load();
  schedule();
  startStream();
}

track('pv', { r: document.referrer || '', p: location.pathname });
refreshOnline();
setInterval(refreshOnline, 30000);

bootstrap();
