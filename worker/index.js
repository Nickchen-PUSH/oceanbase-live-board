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
