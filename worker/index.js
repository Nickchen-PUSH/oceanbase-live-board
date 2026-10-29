// Cloudflare Worker：静态资源（public/）+ 同源 API 中转
//
// 为什么需要这一层：浏览器带 Origin 直接打 openwebapi.oceanbase.com 会被网关 403，
// 所以由 Worker 在边缘抓取，页面只请求同源的 /api/snapshot。
// 缓存两层：isolate 内 TTL（lib/upstream.mjs）+ 边缘 Cache API（12 秒，全机房共享）。
import { configure, getCampId, getSnapshot, getTotalBoard, getTrackBoard } from '../lib/upstream.mjs';
import { toCsv } from '../api/_csv.mjs';

const TTL_SECONDS = 12;

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
    }
  }

  const data = await loader();
  const body = JSON.stringify(data);
  const stored = new Response(body, {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'x-data-at': String(Date.now()), 'Cache-Control': `public, max-age=${TTL_SECONDS}` },
  });
  ctx.waitUntil(cache.put(key, stored));
  return json(JSON.parse(body), 200, { 'X-Cache': force ? 'BYPASS' : 'MISS' });
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

export default {
  async fetch(request, env, ctx) {
    if (env?.CAMP_ID != null) configure({ campId: env.CAMP_ID });
    if (env?.CACHE_TTL_MS != null) configure({ ttlMs: env.CACHE_TTL_MS });

    const url = new URL(request.url);
    const p = url.pathname;

    if (p === '/api/health') {
      return json({ ok: true, campId: getCampId(), cacheTtlMs: TTL_SECONDS * 1000, at: new Date().toISOString(), runtime: 'cloudflare-worker' });
    }

    try {
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
