import { useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo } from 'react';
import { filterByProvince, provinceStats } from '../../shared/province.ts';
import type { Board, Row } from '../../shared/types.ts';
import { BoardPicker } from '../components/BoardPicker.tsx';
import { FeedPanel } from '../components/FeedPanel.tsx';
import { FilterBar } from '../components/FilterBar.tsx';
import { Footer } from '../components/Footer.tsx';
import { Header } from '../components/Header.tsx';
import { Kpis } from '../components/Kpis.tsx';
import { LeaderTable } from '../components/LeaderTable.tsx';
import { ProvinceMap } from '../components/ProvinceMap.tsx';
import { RegionPanel } from '../components/RegionPanel.tsx';
import { ScoreDist } from '../components/ScoreDist.tsx';
import { StarBar } from '../components/StarBar.tsx';
import { TeamDialog } from '../components/TeamDialog.tsx';
import { TimingPanel } from '../components/TimingPanel.tsx';
import { Card, cx, Empty } from '../components/ui.tsx';
import { hit } from '../lib/api.ts';
import { useLive } from '../lib/live.tsx';
import { boardRoute, type BoardSearch, type Tab } from '../router.tsx';

/** 搜索：队名 / 学校 / 导师 / 省份，不区分大小写，空格分隔多个关键词须同时命中 */
function searchRows(rows: Row[], q: string | undefined): Row[] {
  const words = (q || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return rows;
  return rows.filter((r) => {
    const hay = `${r.name}\n${r.school}\n${r.advisor}\n${r.province}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** 筛选后的组内名次（同分并列） */
export function localRanks(rows: Row[]): Map<Row, number> {
  const m = new Map<Row, number>();
  let prev: number | null | undefined;
  let rank = 0;
  rows.forEach((r, i) => {
    if (i === 0 || r.score !== prev) rank = i + 1;
    prev = r.score;
    m.set(r, rank);
  });
  return m;
}

export function BoardPage() {
  const search = boardRoute.useSearch();
  const navigate = useNavigate({ from: '/' });
  const { data, error } = useLive();
  const snap = data?.snap;

  const setSearch = useCallback(
    (patch: Partial<BoardSearch>, replace = true) => {
      void navigate({ search: (prev: BoardSearch) => ({ ...prev, ...patch }), replace });
    },
    [navigate],
  );

  const board: Board | undefined = useMemo(() => {
    if (!snap) return undefined;
    return snap.boards.find((b) => b.id === (search.board || 'total')) ?? snap.boards[0];
  }, [snap, search.board]);

  const province = search.province || '';
  const tab: Tab = search.tab === 'timing' && board?.kind !== 'track' ? 'rank' : search.tab || 'rank';

  const provinceRows = useMemo(() => (board ? filterByProvince(board.rows, province) : []), [board, province]);
  const shownRows = useMemo(() => searchRows(provinceRows, search.q), [provinceRows, search.q]);
  const provinces = useMemo(() => (board ? provinceStats(board.rows) : []), [board]);

  useEffect(() => {
    if (board) hit({ k: 'board', t: board.id });
  }, [board?.id]);
  useEffect(() => {
    if (province) hit({ k: 'province', t: province });
  }, [province]);
  useEffect(() => {
    document.title = board ? `${board.title}${province ? ` · ${province}` : ''} - OceanBase 榜单实时看板` : 'OceanBase 榜单实时看板';
  }, [board?.title, province]);

  const openTeam = useCallback((key: string) => setSearch({ team: key }, false), [setSearch]);

  const tabs: { id: Tab; label: string; show: boolean }[] = [
    { id: 'rank', label: '排行榜', show: true },
    { id: 'dist', label: '分数分布', show: true },
    { id: 'region', label: '省份与学校', show: true },
    { id: 'timing', label: '出分耗时与预测', show: board?.kind === 'track' },
  ];

  return (
    <div className="flex min-h-dvh flex-col">
      <Header />
      <main className="mx-auto w-full max-w-[1440px] flex-1 space-y-4 px-4 py-4 sm:px-6 sm:py-5">
        {!snap ? (
          <Card>
            {error ? (
              <Empty>
                <div className="text-rose-500">数据加载失败：{error.message}</div>
                <div className="mt-1">稍后会自动重试</div>
              </Empty>
            ) : (
              <LoadingSkeleton />
            )}
          </Card>
        ) : (
          board && (
            <>
              <StarBar snap={snap} onOpen={openTeam} />
              <BoardPicker
                boards={snap.boards}
                current={board.id}
                province={province}
                onPick={(id) => setSearch({ board: id === 'total' ? undefined : id, team: undefined }, false)}
              />
              {board.error && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
                  {board.stale ? '上游刷新失败，暂时显示上一次成功抓取的数据：' : '该榜单抓取失败：'}
                  {board.error}
                </div>
              )}
              <FilterBar
                board={board}
                province={province}
                provinces={provinces}
                q={search.q || ''}
                shown={shownRows.length}
                onProvince={(p) => setSearch({ province: p || undefined })}
                onQuery={(q) => setSearch({ q: q || undefined })}
              />
              <Kpis board={board} rows={provinceRows} province={province} snap={snap} />

              <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
                <section className="card min-w-0">
                  <nav
                    className="flex gap-5 overflow-x-auto border-b border-slate-200 px-4 pt-2 dark:border-slate-800"
                    role="tablist"
                    aria-label="视图"
                  >
                    {tabs
                      .filter((t) => t.show)
                      .map((t) => (
                        <button
                          key={t.id}
                          type="button"
                          role="tab"
                          aria-selected={tab === t.id}
                          className="tab shrink-0"
                          onClick={() => setSearch({ tab: t.id === 'rank' ? undefined : t.id })}
                        >
                          {t.label}
                        </button>
                      ))}
                  </nav>
                  <div className={cx(tab === 'rank' ? '' : 'p-4')}>
                    {tab === 'rank' && (
                      <LeaderTable board={board} rows={shownRows} province={province} query={search.q || ''} onOpen={openTeam} />
                    )}
                    {tab === 'dist' && <ScoreDist board={board} rows={provinceRows} province={province} onOpen={openTeam} />}
                    {tab === 'region' && (
                      <RegionPanel
                        board={board}
                        rows={provinceRows}
                        provinces={provinces}
                        province={province}
                        onProvince={(p) => setSearch({ province: p || undefined })}
                        onSchool={(s) => setSearch({ q: s, tab: undefined })}
                      />
                    )}
                    {tab === 'timing' && board.kind === 'track' && <TimingPanel board={board} />}
                  </div>
                </section>

                <aside className="space-y-4">
                  <ProvinceMap
                    stats={provinces}
                    province={province}
                    onPick={(p) => setSearch({ province: p === province ? undefined : p || undefined })}
                  />
                  <FeedPanel snap={snap} board={board} province={province} onOpen={openTeam} />
                </aside>
              </div>
            </>
          )
        )}
      </main>
      <Footer />
      {snap && search.team && <TeamDialog snap={snap} teamKey={search.team} onClose={() => setSearch({ team: undefined })} />}
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="animate-pulse space-y-3 py-4" aria-busy="true" aria-label="加载中">
      <div className="h-6 w-1/3 rounded bg-slate-200 dark:bg-slate-800" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-20 rounded-lg bg-slate-100 dark:bg-slate-800/60" />
        ))}
      </div>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="h-9 rounded bg-slate-100 dark:bg-slate-800/60" />
      ))}
      <p className="pt-2 text-center text-sm text-slate-400">正在从 OceanBase 拉取全部榜单（首次约需数秒）…</p>
    </div>
  );
}
