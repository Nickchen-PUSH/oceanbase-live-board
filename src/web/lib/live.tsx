// 实时数据：TanStack Query 轮询兜底 + WebSocket 推送（gzip 帧，浏览器原生 DecompressionStream 解压）
// 同时在这里比较前后两份快照，累积「实时变化」（只在数据真的换代时比较——旧实现每次轮询都覆盖上一份，
// 导致涨分标记下一次轮询就消失）。
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Snapshot } from '../../shared/types.ts';
import { diffSnapshots, type Change } from '../../shared/insights.ts';
import { fetchSnapshot, streamUrl, type SnapshotResult } from './api.ts';
import { MODE } from './config.ts';
import { createStore } from './store.ts';

export type StreamState = 'connecting' | 'open' | 'off';

export interface LiveValue {
  data: SnapshotResult | undefined;
  error: Error | null;
  isFetching: boolean;
  stream: StreamState;
  refresh: () => void;
}

const LiveContext = createContext<LiveValue | null>(null);

export const useLive = () => {
  const v = useContext(LiveContext);
  if (!v) throw new Error('useLive outside LiveProvider');
  return v;
};

/** 页面打开以来观察到的变化（最新在前，最多 400 条） */
export const changesStore = createStore<Change[]>([]);
/** 变化记录保留时长：表格里的「↑3 / +12 分」标记在这段时间内一直显示 */
export const CHANGE_TTL_MS = 30 * 60_000;

const QUERY_KEY = ['snapshot'];
const MAX_WS_RETRIES = 3;

async function decodeFrame(data: ArrayBuffer | string): Promise<Snapshot> {
  if (typeof data === 'string') return JSON.parse(data) as Snapshot;
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip'));
  return (await new Response(stream).json()) as Snapshot;
}

export function LiveProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [stream, setStream] = useState<StreamState>('off');
  const forceNext = useRef(false);

  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => {
      const force = forceNext.current;
      forceNext.current = false;
      return fetchSnapshot(force);
    },
    // 推送连着时轮询只做兜底；静态快照 CI 每 10 分钟才更新
    refetchInterval: (q) => (stream === 'open' || q.state.data?.source === 'static' ? 60_000 : 15_000),
    staleTime: 5_000,
    retry: 2,
    retryDelay: (n) => Math.min(8_000, 1_000 * 2 ** n),
    structuralSharing: false,
  });

  // ---- WebSocket 推送
  useEffect(() => {
    if (typeof WebSocket === 'undefined' || typeof DecompressionStream === 'undefined') return;
    let ws: WebSocket | null = null;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;

    const connect = () => {
      timer = undefined;
      if (disposed || ws) return;
      setStream('connecting');
      ws = new WebSocket(streamUrl());
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        tries = 0;
        setStream('open');
      };
      ws.onmessage = async (ev) => {
        try {
          const snap = await decodeFrame(ev.data as ArrayBuffer | string);
          // 丢弃比手上更旧的推送（例如服务端在无人在线期间留下的旧快照）
          const cur = qc.getQueryData<SnapshotResult>(QUERY_KEY);
          if (cur && Date.parse(snap.generatedAt) < Date.parse(cur.snap.generatedAt)) return;
          qc.setQueryData<SnapshotResult>(QUERY_KEY, { snap, source: 'push', receivedAt: Date.now() });
        } catch (err) {
          console.warn('[stream] bad frame', err);
        }
      };
      ws.onclose = () => {
        ws = null;
        if (disposed) return;
        setStream('off');
        // 连不上就退回轮询（Pages 模式下 Worker 不可达很常见）
        if (++tries <= MAX_WS_RETRIES) timer = setTimeout(connect, 2_000 * 2 ** tries);
      };
      ws.onerror = () => ws?.close();
    };

    // 页面在后台时断开，回到前台再连（省流量；轮询在后台也会暂停）
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        if (!ws && !timer) {
          tries = 0;
          connect();
        }
      }
    };
    const onHidden = () => {
      if (document.visibilityState === 'hidden') {
        clearTimeout(timer);
        timer = undefined;
        const s = ws;
        ws = null;
        s?.close();
        setStream('off');
      }
    };
    const onVis = () => {
      onHidden();
      onVisible();
    };
    // 推迟到下一轮事件循环：StrictMode 开发模式下 effect 会立即卸载重挂，避免「连接未建立就被关闭」
    timer = setTimeout(connect, 0);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      disposed = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVis);
      ws?.close();
    };
  }, [qc]);

  // ---- 快照换代时比较前后差异
  const prevSnap = useRef<Snapshot | null>(null);
  const snap = query.data?.snap;
  useEffect(() => {
    if (!snap) return;
    const prev = prevSnap.current;
    // 只在快照「向前」换代时比较；旧数据（缓存回退等）不参与，避免把变化算反
    if (prev && Date.parse(snap.generatedAt) <= Date.parse(prev.generatedAt)) return;
    prevSnap.current = snap;
    if (!prev) return;
    const now = Date.now();
    const changes = diffSnapshots(prev, snap, now);
    if (!changes.length) return;
    changesStore.set((list) => [...changes, ...list.filter((c) => now - c.detectedAt < 6 * 3600_000)].slice(0, 400));
  }, [snap]);

  const refresh = useCallback(() => {
    forceNext.current = MODE !== 'pages';
    void qc.invalidateQueries({ queryKey: QUERY_KEY });
  }, [qc]);

  const value = useMemo<LiveValue>(
    () => ({ data: query.data, error: query.error, isFetching: query.isFetching, stream, refresh }),
    [query.data, query.error, query.isFetching, stream, refresh],
  );
  return <LiveContext value={value}>{children}</LiveContext>;
}
