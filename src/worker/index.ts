// Cloudflare Worker：静态资源（dist/client，SPA）+ 同源 API（Hono）+ 推送中枢 / 访问统计（Durable Objects）
//
// 为什么需要这一层：浏览器带 Origin 直接打 openwebapi.oceanbase.com 会被网关 403，
// 所以由 Worker 在边缘抓取，页面只请求同源 /api/*。
// 缓存三层：isolate 内 TTL（upstream.ts）+ 边缘 Cache API（12 秒新鲜 / 5 分钟内先回旧数据后台刷新）
//          + BoardHub 里最近一次推送的快照（有浏览器在线时每 15 秒刷新）。
import { DurableObject } from 'cloudflare:workers';
import { Hono, type MiddlewareHandler } from 'hono';
import type { HitContext } from '../server/visits.ts';
import { VisitStats, type KV } from '../server/visits.ts';
import { createApi, isForce } from '../server/app.ts';
import { configure, errMsg, getConfig, getSnapshot } from '../server/upstream.ts';
import type { HitEvent, OnlineInfo, StatsSummary } from '../shared/types.ts';

export interface Env {
  ASSETS: Fetcher;
  BOARD_HUB: DurableObjectNamespace<BoardHub>;
  BOARD_STATS: DurableObjectNamespace<BoardStats>;
  CAMP_ID?: string;
  CACHE_TTL_MS?: string;
  STATS_KEY?: string;
}

type HonoEnv = { Bindings: Env };

const TTL_SECONDS = 12;
const STALE_SECONDS = 300;
const PUSH_INTERVAL_MS = 15_000;
/** 推送中枢的快照超过这个年龄就不再直接用（旧实现没检查：没人在线时 alarm 停了，/api/snapshot 会返回几天前的数据） */
const HUB_MAX_AGE_MS = PUSH_INTERVAL_MS * 3;

async function gzip(text: string): Promise<ArrayBuffer> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

const hubOf = (env: Env) => env.BOARD_HUB.get(env.BOARD_HUB.idFromName(`camp${getConfig().campId}`));
const statsOf = (env: Env) => env.BOARD_STATS.get(env.BOARD_STATS.idFromName(`camp${getConfig().campId}`));

// ================================================================== 推送中枢
// 有浏览器连着时，每 15 秒抓一次上游并推给所有连接；没人连就停。
// 用 WebSocket Hibernation API：空闲时 DO 可以休眠，不按连接时长计费。
export class BoardHub extends DurableObject<Env> {
  /** 最近一次快照（gzip 后的 JSON），同时持久化在 storage 里，休眠唤醒后可恢复 */
  private gz: ArrayBuffer | null = null;
  private at = 0;
  private lastPush: number | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    configure({ campId: env.CAMP_ID, ttlMs: env.CACHE_TTL_MS });
    ctx.blockConcurrencyWhile(async () => {
      this.gz = (await ctx.storage.get<ArrayBuffer>('gz')) ?? null;
      this.at = (await ctx.storage.get<number>('at')) ?? 0;
      this.lastPush = (await ctx.storage.get<number>('lastPush')) ?? null;
    });
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') return Response.json({ error: 'expected websocket' }, { status: 426 });
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    // 只把「新鲜」的快照立刻发给新连接：没人在线时 alarm 会停，存着的快照可能是几小时前的，
    // 发过去会让页面倒退到旧数据（前端也会丢弃比当前更旧的推送，双保险）
    const fresh = this.gz && Date.now() - this.at < HUB_MAX_AGE_MS;
    if (fresh) server.send(this.gz!);
    await this.arm(fresh && Date.now() - this.at < PUSH_INTERVAL_MS ? PUSH_INTERVAL_MS : 300);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** RPC：最近快照（gzip JSON）及其生成时刻 */
  async latest(): Promise<{ gz: ArrayBuffer; at: number } | null> {
    return this.gz ? { gz: this.gz, at: this.at } : null;
  }

  /** RPC：在线连接数 */
  async online(): Promise<OnlineInfo> {
    return { sockets: this.ctx.getWebSockets().length, lastPush: this.lastPush, intervalMs: PUSH_INTERVAL_MS };
  }

  private async arm(delay: number) {
    const cur = await this.ctx.storage.getAlarm();
    if (cur == null) await this.ctx.storage.setAlarm(Date.now() + delay);
  }

  override async alarm() {
    const sockets = this.ctx.getWebSockets();
    if (sockets.length === 0) return; // 没人连就不轮询，省 CPU / 上游请求
    try {
      const snap = await getSnapshot({ force: true });
      const text = JSON.stringify({ ...snap, push: { intervalMs: PUSH_INTERVAL_MS, clients: sockets.length } });
      this.gz = await gzip(text);
      this.at = Date.parse(snap.generatedAt);
      this.lastPush = Date.now();
      await this.ctx.storage.put({ gz: this.gz, at: this.at, lastPush: this.lastPush });
      for (const ws of sockets) {
        try {
          ws.send(this.gz);
        } catch {
          /* 单连接失败忽略，close 事件会清理 */
        }
      }
    } catch (err) {
      console.warn('[hub] upstream failed:', errMsg(err)); // 连着的浏览器继续看上一版
    }
    if (this.ctx.getWebSockets().length > 0) await this.ctx.storage.setAlarm(Date.now() + PUSH_INTERVAL_MS);
  }

  override async webSocketMessage() {
    /* 单向推送 */
  }

  override async webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code === 1005 ? 1000 : code, 'bye');
    } catch {
      /* 已关闭 */
    }
  }
}

// ================================================================== 访问统计
export class BoardStats extends DurableObject<Env> {
  private visits: VisitStats;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const kv: KV = {
      get: <T>(k: string) => ctx.storage.get<T>(k),
      put: (k, v) => ctx.storage.put(k, v),
    };
    this.visits = new VisitStats(kv);
  }

  async hit(evt: HitEvent, hc: HitContext): Promise<void> {
    await this.visits.hit(evt, hc);
  }

  async summary(days: number, online: number): Promise<StatsSummary> {
    return this.visits.summary(days, online);
  }
}

// ================================================================== 边缘缓存（stale-while-revalidate）
// 上游一次抓全量要 3~11 秒，直接等会以为页面卡死：过期 5 分钟内先给旧数据、后台再刷。
const edgeCache: MiddlewareHandler<HonoEnv> = async (c, next) => {
  if (c.req.method !== 'GET') return next();
  const u = new URL(c.req.url);
  u.searchParams.delete('force');
  u.searchParams.delete('refresh');
  u.searchParams.sort();
  const key = new Request(u.toString(), { method: 'GET' });
  const cache = caches.default;

  if (!isForce(c)) {
    const hit = await cache.match(key);
    if (hit) {
      const age = Math.round((Date.now() - Number(hit.headers.get('x-data-at') || 0)) / 1000);
      if (age < STALE_SECONDS) {
        if (age >= TTL_SECONDS) {
          const refreshUrl = new URL(u);
          refreshUrl.searchParams.set('force', '1');
          c.executionCtx.waitUntil(
            Promise.resolve(app.fetch(new Request(refreshUrl, { headers: c.req.raw.headers }), c.env, c.executionCtx))
              .then(() => undefined, () => undefined),
          );
        }
        const res = new Response(hit.body, hit);
        res.headers.set('X-Cache', age < TTL_SECONDS ? 'HIT' : 'STALE');
        res.headers.set('X-Data-Age', String(age));
        res.headers.set('Cache-Control', 'no-store');
        res.headers.delete('x-data-at');
        return res;
      }
    }
  }

  await next();
  if (c.res.status === 200) {
    const copy = new Response(c.res.clone().body, c.res);
    copy.headers.set('x-data-at', String(Date.now()));
    copy.headers.set('Cache-Control', `public, max-age=${STALE_SECONDS}`);
    c.executionCtx.waitUntil(cache.put(key, copy));
    c.res.headers.set('X-Cache', isForce(c) ? 'BYPASS' : 'MISS');
  }
};

// 推送中枢的快照足够新就直接用（已经 gzip 好了，原样下发）
const hubSnapshot: MiddlewareHandler<HonoEnv> = async (c, next) => {
  if (!isForce(c)) {
    try {
      const latest = await hubOf(c.env).latest();
      if (latest && Date.now() - latest.at < HUB_MAX_AGE_MS) {
        return new Response(latest.gz, {
          encodeBody: 'manual',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Encoding': 'gzip',
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*',
            'X-Source': 'durable-object',
            'X-Data-Age': String(Math.round((Date.now() - latest.at) / 1000)),
          },
        });
      }
    } catch (err) {
      console.warn('[hub] latest failed:', errMsg(err));
    }
  }
  return next();
};

// ================================================================== 路由
const api = createApi<HonoEnv>({
  runtime: 'cloudflare-worker',
  pushIntervalMs: PUSH_INTERVAL_MS,
  online: (c) => hubOf(c.env).online(),
  stats: (c) => {
    if (!c.env.STATS_KEY) return null;
    const stub = statsOf(c.env);
    const cf = (c.req.raw as Request & { cf?: { country?: string } }).cf;
    return {
      key: c.env.STATS_KEY,
      backend: { hit: (e, h) => stub.hit(e, h), summary: (d, o) => stub.summary(d, o) },
      ctx: {
        ua: c.req.header('user-agent') || '',
        ip: c.req.header('cf-connecting-ip') || '',
        geo: cf?.country || '未知',
      },
    };
  },
});

const app = new Hono<HonoEnv>();

app.use('*', async (c, next) => {
  configure({ campId: c.env.CAMP_ID, ttlMs: c.env.CACHE_TTL_MS });
  await next();
});

app.get('/api/stream', (c) => hubOf(c.env).fetch(c.req.raw));
app.get('/api/snapshot', hubSnapshot, edgeCache);
app.get('/api/board/:id', edgeCache);
app.route('/', api);

// 其余请求交给静态资源（wrangler assets；SPA 路由由 not_found_handling 回 index.html）
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default app satisfies ExportedHandler<Env>;
