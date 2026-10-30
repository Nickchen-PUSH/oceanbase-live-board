// 访问统计（只存聚合量）：PV / UV / 来源 / 地区 / 设备 / 榜单点击 / 省份筛选 / CSV 下载 / 外链点击 / 预测使用。
// UV 用「当天盐 + IP + UA」的短哈希去重，不落原始 IP，也不写 cookie。
// 存储抽象成 KV：Worker 里是 Durable Object storage，本地 Bun 是 JSON 文件。
import { TZ_OFFSET_MS } from '../shared/format.ts';
import type { HitEvent, HitKind, NamedCount, StatsDay, StatsSummary } from '../shared/types.ts';

export interface KV {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

export interface HitContext {
  ua: string;
  ip: string;
  /** 国家/地区代码，Worker 里来自 request.cf.country */
  geo: string;
}

interface DayBucket {
  pv: number;
  uv: number;
  csv: number;
  out: number;
  pred: number;
  prov: number;
  boards: Record<string, number>;
  provinces: Record<string, number>;
  refs: Record<string, number>;
  geo: Record<string, number>;
  dev: Record<string, number>;
}

const HIT_KINDS: readonly HitKind[] = ['pv', 'board', 'csv', 'out', 'predict', 'province'];
const MAX_UV_PER_DAY = 50_000;
const MAX_KEYS = 200; // 每个分布字典最多保留的键数（防止恶意打点把存储撑爆）

export const dayKey = (ts = Date.now()) => new Date(ts + TZ_OFFSET_MS).toISOString().slice(0, 10);

export function referrerBucket(ref: unknown): string {
  if (!ref || typeof ref !== 'string') return '直接访问';
  let host = '';
  try {
    host = new URL(ref).hostname.replace(/^www\./, '');
  } catch {
    return '其他';
  }
  if (!host) return '直接访问';
  if (/(^|\.)github\.(io|com)$/.test(host)) return 'GitHub';
  if (/(^|\.)(feishu\.cn|larksuite\.com|larkoffice\.com)$/.test(host)) return '飞书';
  if (/(^|\.)(weixin\.qq\.com|qq\.com|wechat\.com)$/.test(host)) return '微信/QQ';
  if (/(^|\.)(google|bing|baidu|sogou|so|duckduckgo)\.[a-z.]+$/.test(host)) return '搜索引擎';
  if (/(^|\.)(x\.com|twitter\.com|weibo\.com|zhihu\.com|juejin\.cn|v2ex\.com|bilibili\.com|xiaohongshu\.com)$/.test(host))
    return '社交平台';
  if (/(^|\.)oceanbase\.com$/.test(host)) return 'OceanBase';
  return host.slice(0, 60);
}

export function deviceOf(ua = ''): 'bot' | 'tablet' | 'mobile' | 'desktop' {
  if (!ua || /bot|crawler|spider|headless|python-requests|curl\/|wget|httpclient|okhttp/i.test(ua)) return 'bot';
  if (/iPad|Tablet/i.test(ua)) return 'tablet';
  if (/Mobi|Android|iPhone|iPod/i.test(ua)) return 'mobile';
  return 'desktop';
}

async function visitorHash(ip: string, ua: string, day: string) {
  const raw = `${day}|${ip}|${ua}|seekdb-board`;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return [...new Uint8Array(buf).slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const emptyBucket = (): DayBucket => ({
  pv: 0,
  uv: 0,
  csv: 0,
  out: 0,
  pred: 0,
  prov: 0,
  boards: {},
  provinces: {},
  refs: {},
  geo: {},
  dev: {},
});

function bump(obj: Record<string, number>, key: string, n = 1) {
  if (!(key in obj) && Object.keys(obj).length >= MAX_KEYS) key = '其他';
  obj[key] = (obj[key] || 0) + n;
}

/** 校验打点事件（来自不可信的浏览器） */
export function parseHit(body: unknown): HitEvent | null {
  if (!body || typeof body !== 'object') return null;
  const o = body as Record<string, unknown>;
  const k = String(o.k ?? '') as HitKind;
  if (!HIT_KINDS.includes(k)) return null;
  const t = typeof o.t === 'string' ? o.t.slice(0, 40) : undefined;
  const r = typeof o.r === 'string' ? o.r.slice(0, 300) : undefined;
  return { k, t, r };
}

export function clampDays(raw: unknown, def = 14): number {
  if (raw == null || raw === '') return def;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) ? Math.min(60, Math.max(1, n)) : def; // 旧实现 days=abc → NaN → 死循环/崩溃
}

export class VisitStats {
  private days = new Map<string, DayBucket>();
  private uv = new Map<string, Set<string>>();

  constructor(private kv: KV) {}

  private async load(day: string): Promise<DayBucket> {
    let b = this.days.get(day);
    if (!b) {
      const stored = (await this.kv.get<Partial<DayBucket>>(`d:${day}`)) || {};
      b = { ...emptyBucket(), ...stored };
      this.days.set(day, b);
      this.uv.set(day, new Set((await this.kv.get<string[]>(`u:${day}`)) || []));
      // 只在内存里留最近 62 天
      if (this.days.size > 62) {
        const oldest = [...this.days.keys()].sort()[0]!;
        this.days.delete(oldest);
        this.uv.delete(oldest);
      }
    }
    return b;
  }

  async hit(evt: HitEvent, ctx: HitContext, now = Date.now()): Promise<void> {
    const day = dayKey(now);
    const b = await this.load(day);
    const dev = deviceOf(ctx.ua);
    let uvChanged = false;

    switch (evt.k) {
      case 'pv': {
        bump(b.dev, dev);
        if (dev === 'bot') break;
        b.pv += 1;
        bump(b.geo, ctx.geo || '未知');
        bump(b.refs, referrerBucket(evt.r));
        const set = this.uv.get(day)!;
        const h = await visitorHash(ctx.ip || '0.0.0.0', ctx.ua, day);
        if (!set.has(h) && set.size < MAX_UV_PER_DAY) {
          set.add(h);
          b.uv = set.size;
          uvChanged = true;
        }
        break;
      }
      case 'board':
        bump(b.boards, evt.t || '未知');
        break;
      case 'province':
        b.prov += 1;
        bump(b.provinces, evt.t || '未知');
        break;
      case 'csv':
        b.csv += 1;
        break;
      case 'out':
        b.out += 1;
        break;
      case 'predict':
        b.pred += 1;
        break;
    }

    await this.kv.put(`d:${day}`, b);
    if (uvChanged) await this.kv.put(`u:${day}`, [...this.uv.get(day)!]);
  }

  async summary(days: number, online = 0, now = Date.now()): Promise<StatsSummary> {
    const series: StatsDay[] = [];
    const merged = { boards: {}, provinces: {}, refs: {}, geo: {}, dev: {} } as Record<
      'boards' | 'provinces' | 'refs' | 'geo' | 'dev',
      Record<string, number>
    >;
    const totals = { pv: 0, uvDaySum: 0, uvPeak: 0, csv: 0, out: 0, pred: 0, prov: 0 };
    let last: DayBucket = emptyBucket();

    for (let i = days - 1; i >= 0; i--) {
      const day = dayKey(now - i * 86_400_000);
      const b = await this.load(day);
      last = b;
      series.push({ day, pv: b.pv, uv: b.uv, csv: b.csv, out: b.out, pred: b.pred, prov: b.prov });
      totals.pv += b.pv;
      totals.uvDaySum += b.uv;
      totals.uvPeak = Math.max(totals.uvPeak, b.uv);
      totals.csv += b.csv;
      totals.out += b.out;
      totals.pred += b.pred;
      totals.prov += b.prov;
      for (const k of Object.keys(merged) as (keyof typeof merged)[]) {
        for (const [kk, vv] of Object.entries(b[k] || {})) merged[k][kk] = (merged[k][kk] || 0) + vv;
      }
    }

    const top = (obj: Record<string, number>, n = 12): NamedCount[] =>
      Object.entries(obj)
        .sort((a, b) => b[1] - a[1])
        .slice(0, n)
        .map(([name, count]) => ({ name, count }));

    return {
      ok: true,
      days,
      today: series[series.length - 1]!,
      series,
      totals,
      boards: top(merged.boards),
      todayBoards: top(last.boards),
      provinces: top(merged.provinces, 40),
      refs: top(merged.refs),
      geo: top(merged.geo),
      dev: top(merged.dev),
      online,
    };
  }
}

/** 内存 KV（测试 / 本地服务） */
export function memoryKV(init?: Record<string, unknown>, onChange?: (data: Record<string, unknown>) => void): KV {
  const data: Record<string, unknown> = { ...init };
  return {
    async get<T>(k: string) {
      return data[k] as T | undefined;
    },
    async put(k: string, v: unknown) {
      data[k] = structuredClone(v);
      onChange?.(data);
    },
  };
}
