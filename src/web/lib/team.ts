// 跨榜单找同一支队伍：按 rowKey（groupId 优先）匹配，绝不按队名模糊匹配
import { rowKey } from '../../shared/insights.ts';
import type { Board, Row, Snapshot } from '../../shared/types.ts';

export interface TeamTrack {
  board: Board;
  row: Row | null;
  /** 该赛道当前最高分（视作满分） */
  full: number;
}

export interface TeamView {
  key: string;
  total: Row | null;
  /** 任意一个能找到的行，用来取队名/学校 */
  any: Row | null;
  tracks: TeamTrack[];
}

export function findTeam(snap: Snapshot, key: string): TeamView {
  let total: Row | null = null;
  let any: Row | null = null;
  const tracks: TeamTrack[] = [];
  for (const b of snap.boards) {
    const row = b.rows.find((r) => rowKey(r) === key) ?? null;
    if (row && !any) any = row;
    if (b.kind === 'total') total = row;
    else tracks.push({ board: b, row, full: b.rows.reduce((m, r) => Math.max(m, r.score ?? 0), 0) });
  }
  return { key, total, any: total ?? any, tracks };
}
