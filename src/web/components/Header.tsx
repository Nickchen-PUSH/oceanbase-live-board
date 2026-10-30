import { Link } from '@tanstack/react-router';
import { fmtTime, timeAgo } from '../../shared/format.ts';
import { useNow } from '../lib/hooks.ts';
import { useLive } from '../lib/live.tsx';
import { Logo } from './Logo.tsx';
import { cx } from './ui.tsx';

export function Header() {
  const { data, error, isFetching, stream, refresh } = useLive();
  const now = useNow(1000);
  const gen = data ? Date.parse(data.snap.generatedAt) : null;

  let tone: 'green' | 'blue' | 'amber' | 'red' = 'blue';
  let label = '连接中…';
  let hint = '';
  if (data) {
    if (data.source === 'static') {
      tone = 'amber';
      label = '静态快照';
      hint = '实时接口暂不可达，显示的是 GitHub Actions 每 10 分钟抓取的快照';
    } else if (stream === 'open') {
      tone = 'green';
      label = '实时推送';
      hint = `服务端每 ${(data.snap.push?.intervalMs ?? 15000) / 1000} 秒抓取一次上游并推送`;
    } else {
      tone = 'blue';
      label = '自动刷新';
      hint = '每 15 秒轮询一次';
    }
    if (error) {
      tone = 'amber';
      label = '刷新失败';
      hint = `最近一次刷新失败（${error.message}），显示的是上一份数据`;
    }
  } else if (error) {
    tone = 'red';
    label = '连接失败';
    hint = error.message;
  }
  const dot = {
    green: 'bg-emerald-500',
    blue: 'bg-brand-500',
    amber: 'bg-amber-500',
    red: 'bg-rose-500',
  }[tone];

  return (
    <header className="sticky top-0 z-30 border-b border-slate-200/80 bg-white/85 backdrop-blur-md dark:border-slate-800 dark:bg-[#0b0f17]/85">
      <div className="mx-auto flex h-14 max-w-[1440px] items-center gap-3 px-4 sm:px-6">
        <Link to="/" search={{}} className="flex min-w-0 items-center gap-2.5">
          <Logo className="size-8 shrink-0 drop-shadow-sm" />
          <span className="min-w-0">
            <span className="block truncate text-[15px] font-semibold leading-tight">OceanBase 榜单实时看板</span>
            <span className="hidden truncate text-[11px] text-slate-500 sm:block dark:text-slate-400">
              数据库大赛总榜 · 训练营各赛道 · 省份筛选 · 出分预测
            </span>
          </span>
        </Link>

        <div className="ml-auto flex items-center gap-2 sm:gap-3">
          <div
            className="flex shrink-0 items-center gap-2 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs whitespace-nowrap dark:border-slate-700 dark:bg-slate-900"
            title={hint}
          >
            <span className={cx('size-2 rounded-full', dot, tone === 'green' && 'pulse-dot')} />
            <span className="font-medium">{label}</span>
            {gen != null && (
              <span className="num hidden text-slate-500 sm:inline dark:text-slate-400" title={`数据生成于 ${fmtTime(gen)}（北京时间）`}>
                · {timeAgo(gen, now)}更新
              </span>
            )}
          </div>
          <button
            type="button"
            className="btn px-2.5"
            onClick={refresh}
            disabled={isFetching}
            title="立即刷新（跳过缓存）"
          >
            <svg viewBox="0 0 20 20" className={cx('size-4', isFetching && 'animate-spin')} fill="none" aria-hidden>
              <path
                d="M16.5 10a6.5 6.5 0 1 1-1.9-4.6M16.5 3.5v3.2h-3.2"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="hidden sm:inline">刷新</span>
          </button>
        </div>
      </div>
    </header>
  );
}
