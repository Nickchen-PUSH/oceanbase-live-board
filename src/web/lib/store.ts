// 极简外部 store（React 原生 useSyncExternalStore），用于跨组件共享：关注的队伍、实时变化记录
import { useSyncExternalStore } from 'react';

export interface Store<T> {
  get(): T;
  set(next: T | ((prev: T) => T)): void;
  subscribe(fn: () => void): () => void;
}

export function createStore<T>(initial: T, persistKey?: string): Store<T> {
  let state = initial;
  if (persistKey && typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem(persistKey);
      if (raw) state = JSON.parse(raw) as T;
    } catch {
      /* 损坏的存储忽略 */
    }
  }
  const subs = new Set<() => void>();
  const store: Store<T> = {
    get: () => state,
    set(next) {
      const v = typeof next === 'function' ? (next as (p: T) => T)(state) : next;
      if (Object.is(v, state)) return;
      state = v;
      if (persistKey) {
        try {
          localStorage.setItem(persistKey, JSON.stringify(v));
        } catch {
          /* 隐私模式等 */
        }
      }
      subs.forEach((f) => f());
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
  // 多标签页同步
  if (persistKey && typeof window !== 'undefined') {
    window.addEventListener('storage', (e) => {
      if (e.key !== persistKey || e.newValue == null) return;
      try {
        state = JSON.parse(e.newValue) as T;
        subs.forEach((f) => f());
      } catch {
        /* ignore */
      }
    });
  }
  return store;
}

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
