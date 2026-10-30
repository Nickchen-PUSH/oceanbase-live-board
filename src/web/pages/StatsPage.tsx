// 访问统计后台：/stats?key=xxx（或输入后存 sessionStorage）。数据接口 /api/stats 需要 Bearer key。
import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { fmtInt } from '../../shared/format.ts';
import { provinceShort } from '../../shared/province.ts';
import type { NamedCount, StatsDay } from '../../shared/types.ts';
import { Card, cx, Empty, Stat } from '../components/ui.tsx';
import { fetchStats, HttpError } from '../lib/api.ts';
import { BASEPATH } from '../lib/config.ts';
import { useLive } from '../lib/live.tsx';

const KEY_STORE = 'ob-board:stats-key';
const RANGES = [7, 14, 30] as const;

function initialKey() {
  const fromUrl = new URLSearchParams(location.search).get('key');
  if (fromUrl) {
    sessionStorage.setItem(KEY_STORE, fromUrl);
    // key 不留在地址栏 / 历史记录里
    const u = new URL(location.href);
    u.searchParams.delete('key');
    history.replaceState(history.state, '', u);
    return fromUrl;
  }
  return sessionStorage.getItem(KEY_STORE) || '';
}

export function StatsPage() {
  const [key, setKey] = useState(initialKey);
  const [days, setDays] = useState<number>(14);
  useEffect(() => {
    document.title = '访问统计 · OceanBase 榜单看板';
  }, []);

  const q = useQuery({
    queryKey: ['stats', key, days],
    queryFn: () => fetchStats(key, days),
    enabled: !!key,
    refetchInterval: 30_000,
    retry: (n, err) => !(err instanceof HttpError && (err.status === 404 || err.status === 401 || err.status === 503)) && n < 2,
  });

  const badKey = q.error instanceof HttpError && (q.error.status === 404 || q.error.status === 401);
  if (!key || badKey) {
    return (
      <KeyForm
        error={badKey ? '密钥不对' : null}
        onSubmit={(k) => {
          sessionStorage.setItem(KEY_STORE, k);
          setKey(k);
        }}
      />
    );
  }

  const s = q.data;
  return (
    <div className="mx-auto max-w-6xl space-y-4 px-4 py-6 sm:px-6">
      <header className="flex flex-wrap items-center gap-3">
        <a href={BASEPATH} className="text-sm text-brand-600 hover:underline">
          ← 回到榜单
        </a>
        <h1 className="text-lg font-semibold">访问统计</h1>
        <div className="ml-auto flex items-center gap-1">
          {RANGES.map((d) => (
            <button key={d} type="button" className="chip" aria-pressed={days === d} onClick={() => setDays(d)}>
              近 {d} 天
            </button>
          ))}
          <button
            type="button"
            className="btn ml-2"
            onClick={() => {
              sessionStorage.removeItem(KEY_STORE);
              setKey('');
            }}
          >
            退出
          </button>
        </div>
      </header>

      {q.error && !badKey && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
          {q.error instanceof HttpError && q.error.status === 503 ? '服务端没有配置 STATS_KEY，统计未开启' : `加载失败：${q.error.message}`}
        </div>
      )}

      {!s ? (
        <Empty>{q.isLoading ? '加载中…' : '暂无数据'}</Empty>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
            <Stat label="今日 PV" value={fmtInt(s.today.pv)} tone="brand" />
            <Stat label="今日 UV" value={fmtInt(s.today.uv)} tone="brand" />
            <Stat label="当前在线" value={fmtInt(s.online)} sub="WebSocket 连接数" />
            <Stat label={`${s.days} 天 PV`} value={fmtInt(s.totals.pv)} />
            <Stat label="单日 UV 峰值" value={fmtInt(s.totals.uvPeak)} sub={`日 UV 合计 ${fmtInt(s.totals.uvDaySum)}`} />
            <Stat label="CSV 导出" value={fmtInt(s.totals.csv)} sub={`今日 ${fmtInt(s.today.csv)}`} />
            <Stat label="出分预测" value={fmtInt(s.totals.pred)} sub={`今日 ${fmtInt(s.today.pred)} · 外链 ${fmtInt(s.totals.out)}`} />
          </div>

          <Card title="每日访问" extra={<Legend />}>
            <DailyChart series={s.series} />
          </Card>

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <BoardTable title="榜单切换" rows={s.boards} today={s.todayBoards} />
            <CountTable title="省份筛选" rows={s.provinces.map((x) => ({ ...x, name: provinceShort(x.name) || x.name }))} />
            <CountTable title="来源" rows={s.refs} />
            <CountTable title="地区（国家/地区）" rows={s.geo} />
            <CountTable title="设备" rows={s.dev} />
          </div>
          <p className="text-xs text-slate-400">
            UV 按「日期 + IP + UA」加盐哈希去重，跨天无法合并，所以区间只给日 UV 之和与峰值。本机访问不计入。
          </p>
        </>
      )}
    </div>
  );
}

function KeyForm({ error, onSubmit }: { error: string | null; onSubmit: (k: string) => void }) {
  const [v, setV] = useState('');
  return (
    <div className="mx-auto mt-24 max-w-sm px-4">
      <form
        className="card space-y-3 p-6"
        onSubmit={(e) => {
          e.preventDefault();
          if (v.trim()) onSubmit(v.trim());
        }}
      >
        <h1 className="text-base font-semibold">访问统计</h1>
        <input className="input w-full" type="password" autoFocus placeholder="统计密钥 STATS_KEY" value={v} onChange={(e) => setV(e.target.value)} />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button type="submit" className="btn btn-primary w-full">
          查看
        </button>
        <a href={BASEPATH} className="block text-center text-xs text-slate-400 hover:underline">
          回到榜单
        </a>
      </form>
    </div>
  );
}

const Legend = () => (
  <div className="flex gap-3 text-xs text-slate-500">
    <span className="flex items-center gap-1">
      <i className="size-2.5 rounded-sm bg-brand-300 dark:bg-brand-700" /> PV
    </span>
    <span className="flex items-center gap-1">
      <i className="size-2.5 rounded-sm bg-brand-600 dark:bg-brand-400" /> UV
    </span>
  </div>
);

function DailyChart({ series }: { series: StatsDay[] }) {
  const max = Math.max(1, ...series.map((d) => d.pv));
  if (!series.length) return <Empty>暂无数据</Empty>;
  return (
    <div className="flex h-48 items-end gap-1">
      {series.map((d) => (
        <div key={d.day} className="group relative flex h-full min-w-0 flex-1 flex-col items-center justify-end">
          <div className="relative w-full max-w-10" style={{ height: `${(d.pv / max) * 100}%` }}>
            <div className="absolute inset-0 rounded-t bg-brand-300 dark:bg-brand-700" />
            <div className="absolute inset-x-1 bottom-0 rounded-t bg-brand-600 dark:bg-brand-400" style={{ height: `${d.pv ? (d.uv / d.pv) * 100 : 0}%` }} />
          </div>
          <div className="num mt-1 text-[10px] text-slate-400">{d.day.slice(5)}</div>
          <div className="pointer-events-none absolute bottom-full mb-1 hidden rounded bg-slate-900/90 px-2 py-1 text-[11px] whitespace-nowrap text-white group-hover:block">
            {d.day} · PV {d.pv} · UV {d.uv}
            {d.csv ? ` · CSV ${d.csv}` : ''}
            {d.pred ? ` · 预测 ${d.pred}` : ''}
          </div>
        </div>
      ))}
    </div>
  );
}

function CountTable({ title, rows, extra }: { title: string; rows: NamedCount[]; extra?: (r: NamedCount) => ReactNode }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, 10);
  return (
    <Card title={title} bodyClass="pt-1">
      {!rows.length ? (
        <Empty>暂无</Empty>
      ) : (
        <ul className="space-y-1.5 text-sm">
          {shown.map((r) => (
            <li key={r.name} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3">
              <span className="truncate" title={r.name}>
                {r.name}
                {extra?.(r)}
              </span>
              <span className="num text-right text-slate-600 dark:text-slate-300">{fmtInt(r.count)}</span>
              <span className="col-span-2 h-1 rounded-full bg-slate-100 dark:bg-slate-800">
                <span className="block h-1 rounded-full bg-brand-400" style={{ width: `${(r.count / max) * 100}%` }} />
              </span>
            </li>
          ))}
          {rows.length > 10 && (
            <li>
              <button type="button" className={cx('text-xs text-brand-600 hover:underline')} onClick={() => setAll(!all)}>
                {all ? '收起' : `展开全部 ${rows.length} 项`}
              </button>
            </li>
          )}
        </ul>
      )}
    </Card>
  );
}

function BoardTable({ title, rows, today }: { title: string; rows: NamedCount[]; today: NamedCount[] }) {
  const { data } = useLive();
  const titles = useMemo(() => new Map(data?.snap.boards.map((b) => [b.id, b.title]) ?? []), [data?.snap.generatedAt]);
  const todayMap = useMemo(() => new Map(today.map((x) => [x.name, x.count])), [today]);
  const named = rows.map((r) => ({ ...r, name: titles.get(r.name) ?? r.name, id: r.name }));
  return (
    <CountTable
      title={title}
      rows={named}
      extra={(r) => {
        const id = (r as NamedCount & { id?: string }).id ?? r.name;
        const t = todayMap.get(id);
        return t ? <span className="ml-1.5 text-xs text-slate-400">今日 {t}</span> : null;
      }}
    />
  );
}
