// 展示用格式化。所有钟点统一按北京时间（UTC+8）显示：比赛在国内，
// 访问者也几乎都在国内；固定时区还能让 Worker / 测试 / 浏览器输出一致。

export const TZ_OFFSET_MS = 8 * 3600 * 1000;

const p2 = (x: number) => String(x).padStart(2, '0');

/** 北京时间的「墙上时间」分量 */
export function bj(ts: number) {
  const d = new Date(ts + TZ_OFFSET_MS);
  return {
    y: d.getUTCFullYear(),
    mo: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    h: d.getUTCHours(),
    mi: d.getUTCMinutes(),
    s: d.getUTCSeconds(),
  };
}

/** 北京时间当天 0 点（毫秒时间戳） */
export function bjDayStart(ts: number): number {
  return Math.floor((ts + TZ_OFFSET_MS) / 86400000) * 86400000 - TZ_OFFSET_MS;
}

export function toMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const v = Date.parse(iso);
  return Number.isFinite(v) ? v : null;
}

/** 10-30 16:22 */
export function fmtClock(ts: number | null | undefined): string {
  if (ts == null || !Number.isFinite(ts)) return '—';
  const c = bj(ts);
  return `${p2(c.mo)}-${p2(c.d)} ${p2(c.h)}:${p2(c.mi)}`;
}

/** 10-30 16:22:07 */
export function fmtTime(ts: number | string | null | undefined): string {
  const v = typeof ts === 'string' ? toMs(ts) : ts;
  if (v == null || !Number.isFinite(v)) return '—';
  const c = bj(v);
  return `${p2(c.mo)}-${p2(c.d)} ${p2(c.h)}:${p2(c.mi)}:${p2(c.s)}`;
}

/** 16:22 */
export function fmtHM(ts: number | null | undefined): string {
  if (ts == null || !Number.isFinite(ts)) return '—';
  const c = bj(ts);
  return `${p2(c.h)}:${p2(c.mi)}`;
}

/** 相对今天的友好钟点：「今天 16:22」「明天 09:00」「10-28 03:10」 */
export function fmtWhen(ts: number | null | undefined, now = Date.now()): string {
  if (ts == null || !Number.isFinite(ts)) return '—';
  const diffDays = Math.round((bjDayStart(ts) - bjDayStart(now)) / 86400000);
  const label = diffDays === 0 ? '今天' : diffDays === 1 ? '明天' : diffDays === -1 ? '昨天' : diffDays === 2 ? '后天' : null;
  return label ? `${label} ${fmtHM(ts)}` : fmtClock(ts);
}

/** 时长（秒）→「45 秒」「12 分钟」「3.5 小时」「1.2 天」 */
export function fmtDur(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return '—';
  if (sec <= 0) return '0 秒';
  if (sec < 1) return `${sec.toFixed(2)} 秒`;
  if (sec < 90) return `${sec.toFixed(sec < 10 ? 1 : 0)} 秒`;
  if (sec < 3600) return `${(sec / 60).toFixed(sec < 600 ? 1 : 0)} 分钟`;
  if (sec < 86400) return `${(sec / 3600).toFixed(1)} 小时`;
  return `${(sec / 86400).toFixed(1)} 天`;
}

/** 「3 秒前」「5 分钟前」「2 小时前」「3 天前」 */
export function timeAgo(ts: number | null | undefined, now = Date.now()): string {
  if (ts == null || !Number.isFinite(ts) || ts <= 0) return '—';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s} 秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

export const fmtScore = (n: number | null | undefined, digits = 3): string =>
  n == null || !Number.isFinite(n) ? '—' : n.toFixed(digits);

/** 去掉尾随 0 的分数：600.000 → 600，616.568 → 616.568 */
export const fmtScoreShort = (n: number | null | undefined): string =>
  n == null || !Number.isFinite(n) ? '—' : String(Number(n.toFixed(3)));

export const fmtInt = (n: number | null | undefined): string =>
  n == null || !Number.isFinite(n) ? '—' : n.toLocaleString('zh-CN');

export const fmtPct = (x: number | null | undefined, digits = 0): string =>
  x == null || !Number.isFinite(x) ? '—' : `${(x * 100).toFixed(digits)}%`;
