// 关注的队伍：存 localStorage，跨榜单按 rowKey（groupId 优先）识别
import { useCallback } from 'react';
import type { Row } from '../../shared/types.ts';
import { rowKey } from '../../shared/insights.ts';
import { createStore, useStore } from './store.ts';

export interface StarredTeam {
  key: string;
  name: string;
  groupId: number | null;
  addedAt: number;
}

export const starsStore = createStore<StarredTeam[]>([], 'ob-board:stars:v2');

export function useStars() {
  const stars = useStore(starsStore);
  const isStarred = useCallback((r: Row) => stars.some((s) => s.key === rowKey(r)), [stars]);
  return { stars, isStarred };
}

export function toggleStar(r: Row) {
  const key = rowKey(r);
  starsStore.set((list) =>
    list.some((s) => s.key === key)
      ? list.filter((s) => s.key !== key)
      : [...list, { key, name: r.name, groupId: r.groupId, addedAt: Date.now() }].slice(-20),
  );
}

export function unstar(key: string) {
  starsStore.set((list) => list.filter((s) => s.key !== key));
}
