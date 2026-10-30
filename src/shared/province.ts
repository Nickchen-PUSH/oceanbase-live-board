// 省份工具：筛选、简称、分布统计（前端与服务端共用）
import type { Row } from './types.ts';

/** 筛选值：'' = 全部；NO_PROVINCE = 未填省份 */
export const NO_PROVINCE = '__none__';

export function filterByProvince<T extends Pick<Row, 'province'>>(rows: T[], province: string | null | undefined): T[] {
  if (!province) return rows;
  if (province === NO_PROVINCE) return rows.filter((r) => !r.province);
  return rows.filter((r) => r.province === province);
}

const SPECIAL: Record<string, string> = {
  内蒙古自治区: '内蒙古',
  广西壮族自治区: '广西',
  西藏自治区: '西藏',
  宁夏回族自治区: '宁夏',
  新疆维吾尔自治区: '新疆',
  香港特别行政区: '香港',
  澳门特别行政区: '澳门',
};

/** 四川省 → 四川，北京市 → 北京，新疆维吾尔自治区 → 新疆 */
export function provinceShort(p: string): string {
  if (!p) return '未填';
  if (SPECIAL[p]) return SPECIAL[p];
  return p.replace(/(省|市|特别行政区|自治区)$/, '') || p;
}

export const provinceLabel = (p: string) => (p === NO_PROVINCE ? '未填省份' : p);

export interface ProvinceStat {
  /** 省份全称；'' = 未填 */
  province: string;
  teams: number;
  /** 前 10 名里的队伍数 */
  top10: number;
  /** 最好名次 */
  bestRank: number | null;
  /** 有成绩队伍的平均分 */
  avgScore: number | null;
  /** 有成绩队伍的中位分 */
  medianScore: number | null;
  /** 该省最高分队伍名 */
  leader: string | null;
}

/** 按队伍数降序（未填省份始终排最后） */
export function provinceStats(rows: Row[]): ProvinceStat[] {
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const k = r.province || '';
    let g = groups.get(k);
    if (!g) groups.set(k, (g = []));
    g.push(r);
  }
  const out: ProvinceStat[] = [];
  for (const [province, list] of groups) {
    const scores = list.map((r) => r.score).filter((s): s is number => s != null).sort((a, b) => a - b);
    const best = list.reduce<Row | null>((b, r) => (r.score != null && (b == null || r.rank < b.rank) ? r : b), null);
    const mid = scores.length >> 1;
    out.push({
      province,
      teams: list.length,
      top10: list.filter((r) => r.rank > 0 && r.rank <= 10).length,
      bestRank: best ? best.rank : null,
      avgScore: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
      medianScore: scores.length
        ? scores.length % 2
          ? scores[mid]!
          : (scores[mid - 1]! + scores[mid]!) / 2
        : null,
      leader: best ? best.name : null,
    });
  }
  return out.sort((a, b) => {
    if (!a.province !== !b.province) return a.province ? -1 : 1;
    return b.teams - a.teams || (a.bestRank ?? 1e9) - (b.bestRank ?? 1e9) || a.province.localeCompare(b.province, 'zh');
  });
}
