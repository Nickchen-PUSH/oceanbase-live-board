import { useMemo } from 'react';
import { filterByProvince } from '../../shared/province.ts';
import type { Board } from '../../shared/types.ts';
import { cx } from './ui.tsx';

export function BoardPicker({
  boards,
  current,
  province,
  onPick,
}: {
  boards: Board[];
  current: string;
  province: string;
  onPick: (id: string) => void;
}) {
  const counts = useMemo(
    () => new Map(boards.map((b) => [b.id, province ? filterByProvince(b.rows, province).length : b.rows.length])),
    [boards, province],
  );
  return (
    <nav aria-label="选择榜单" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0">
      {boards.map((b) => {
        const on = b.id === current;
        const n = counts.get(b.id) ?? 0;
        return (
          <button
            key={b.id}
            type="button"
            aria-current={on ? 'page' : undefined}
            onClick={() => onPick(b.id)}
            className={cx('chip shrink-0', b.kind === 'total' && !on && 'font-semibold text-slate-800 dark:text-slate-100')}
            title={`${b.title}${province ? `（${province} ${n} 队）` : `（${n} 队）`}`}
          >
            {b.kind === 'total' && <span aria-hidden>🏆</span>}
            <span className="max-w-[16em] truncate">{b.kind === 'total' ? '总榜' : b.title}</span>
            <span
              className={cx(
                'num rounded-full px-1.5 text-[11px]',
                on ? 'bg-white/20' : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400',
                b.error && !on && 'bg-amber-100 text-amber-700',
              )}
            >
              {n}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
