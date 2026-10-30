// TanStack Router（代码式路由）：页面状态全部放在 URL 搜索参数里，可分享、可前进后退
import { createRootRoute, createRoute, createRouter, Outlet } from '@tanstack/react-router';
import { BASEPATH } from './lib/config.ts';
import { BoardPage } from './pages/BoardPage.tsx';
import { StatsPage } from './pages/StatsPage.tsx';

export const TABS = ['rank', 'dist', 'region', 'timing'] as const;
export type Tab = (typeof TABS)[number];

export interface BoardSearch {
  /** 榜单 id：total | q600071 … */
  board?: string;
  /** 省份全称；'__none__' = 未填 */
  province?: string;
  /** 队伍 / 学校 / 导师搜索 */
  q?: string;
  tab?: Tab;
  /** 打开详情抽屉的队伍 rowKey */
  team?: string;
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 80) : undefined);

const rootRoute = createRootRoute({ component: Outlet });

export const boardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  validateSearch: (s: Record<string, unknown>): BoardSearch => {
    const board = str(s.board);
    const tab = TABS.includes(s.tab as Tab) ? (s.tab as Tab) : undefined;
    return {
      board: board && board !== 'total' ? board : undefined,
      province: str(s.province),
      q: str(s.q),
      tab: tab && tab !== 'rank' ? tab : undefined,
      team: str(s.team),
    };
  },
  component: BoardPage,
});

export const statsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/stats',
  component: StatsPage,
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([boardRoute, statsRoute]),
  basepath: BASEPATH,
  defaultPreload: false,
  scrollRestoration: true,
  defaultNotFoundComponent: () => (
    <div className="mx-auto max-w-md p-10 text-center text-slate-500">
      页面不存在，<a className="text-brand-600 underline" href={BASEPATH}>回到榜单</a>
    </div>
  ),
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
