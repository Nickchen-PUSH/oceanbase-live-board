import type { ReactNode } from 'react';

export const cx = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(' ');

export function Card({
  title,
  extra,
  children,
  className,
  bodyClass,
}: {
  title?: ReactNode;
  extra?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClass?: string;
}) {
  return (
    <section className={cx('card', className)}>
      {(title || extra) && (
        <header className="flex items-center justify-between gap-3 px-4 pt-3.5">
          {title && <h2 className="card-title">{title}</h2>}
          {extra}
        </header>
      )}
      <div className={cx('p-4', title || extra ? 'pt-3' : '', bodyClass)}>{children}</div>
    </section>
  );
}

export function Stat({
  label,
  value,
  sub,
  tone = 'default',
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  tone?: 'default' | 'brand' | 'warn';
}) {
  return (
    <div className="card px-4 py-3">
      <div className="text-xs text-slate-500 dark:text-slate-400">{label}</div>
      <div
        className={cx(
          'num mt-1 truncate text-2xl font-semibold tracking-tight',
          tone === 'brand' && 'text-brand-600 dark:text-brand-300',
          tone === 'warn' && 'text-amber-600 dark:text-amber-400',
        )}
      >
        {value}
      </div>
      {sub != null && <div className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">{sub}</div>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="py-10 text-center text-sm text-slate-400 dark:text-slate-500">{children}</div>;
}

const MEDAL = ['bg-gold text-white', 'bg-silver text-white', 'bg-bronze text-white'];

export function RankBadge({ rank }: { rank: number }) {
  if (rank >= 1 && rank <= 3)
    return (
      <span className={cx('num inline-flex size-6 items-center justify-center rounded-full text-xs font-bold', MEDAL[rank - 1])}>
        {rank}
      </span>
    );
  return <span className="num inline-block min-w-6 text-center text-slate-500 dark:text-slate-400">{rank || '—'}</span>;
}

/** 名次变化：正数 = 名次上升 */
export function RankDelta({ d }: { d: number | null | undefined }) {
  if (!d) return null;
  return d > 0 ? (
    <span className="num text-[11px] font-medium text-emerald-600 dark:text-emerald-400" title={`名次上升 ${d}`}>
      ▲{d}
    </span>
  ) : (
    <span className="num text-[11px] font-medium text-rose-500" title={`名次下降 ${-d}`}>
      ▼{-d}
    </span>
  );
}

export function ScoreDelta({ d }: { d: number | null | undefined }) {
  if (d == null || !Number.isFinite(d) || Math.abs(d) < 1e-9) return null;
  return (
    <span
      className={cx(
        'badge num',
        d > 0
          ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'
          : 'bg-rose-50 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300',
      )}
    >
      {d > 0 ? '+' : ''}
      {Number(d.toFixed(3))}
    </span>
  );
}

export function StarButton({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      aria-pressed={on}
      title={on ? `取消关注 ${label}` : `关注 ${label}`}
      className={cx(
        'inline-flex size-7 items-center justify-center rounded-md text-base leading-none transition-colors',
        on ? 'text-amber-500 hover:text-amber-600' : 'text-slate-300 hover:text-amber-500 dark:text-slate-600',
      )}
    >
      {on ? '★' : '☆'}
    </button>
  );
}

export function Pill({ children, tone = 'slate' }: { children: ReactNode; tone?: 'slate' | 'green' | 'amber' | 'red' | 'brand' }) {
  const t = {
    slate: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
    green: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
    amber: 'bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
    red: 'bg-rose-50 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300',
    brand: 'bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-300',
  }[tone];
  return <span className={cx('badge', t)}>{children}</span>;
}
