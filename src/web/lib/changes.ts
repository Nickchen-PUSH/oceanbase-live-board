import { useMemo } from 'react';
import type { Change } from '../../shared/insights.ts';
import { CHANGE_TTL_MS, changesStore } from './live.tsx';
import { useNow } from './hooks.ts';
import { useStore } from './store.ts';

/** 某榜单最近 CHANGE_TTL_MS 内的变化，按队伍 key 取最新一条（并合并名次变化的起点） */
export function useRecentChanges(boardId: string | undefined): Map<string, Change> {
  const all = useStore(changesStore);
  const now = useNow(60_000);
  return useMemo(() => {
    const m = new Map<string, Change>();
    if (!boardId) return m;
    // changesStore 最新在前：第一次遇到的就是最新的；更早的记录只用来把 prevRank/prevScore 往前推
    for (const c of all) {
      if (c.boardId !== boardId || now - c.detectedAt > CHANGE_TTL_MS) continue;
      const cur = m.get(c.key);
      if (!cur) m.set(c.key, c);
      else
        m.set(c.key, {
          ...cur,
          prevRank: c.prevRank ?? cur.prevRank,
          prevScore: c.prevScore ?? cur.prevScore,
          isNew: cur.isNew || c.isNew,
          kind: c.isNew ? 'new' : cur.kind,
        });
    }
    return m;
  }, [all, boardId, now]);
}
