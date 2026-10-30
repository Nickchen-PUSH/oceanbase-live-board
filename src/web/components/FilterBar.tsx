import { useEffect, useState } from 'react';
import { NO_PROVINCE, provinceLabel, type ProvinceStat } from '../../shared/province.ts';
import type { Board } from '../../shared/types.ts';
import { csvUrl, hit } from '../lib/api.ts';

export function FilterBar({
  board,
  province,
  provinces,
  q,
  shown,
  onProvince,
  onQuery,
}: {
  board: Board;
  province: string;
  provinces: ProvinceStat[];
  q: string;
  shown: number;
  onProvince: (p: string) => void;
  onQuery: (q: string) => void;
}) {
  // 输入框本地状态 + 防抖写回 URL
  const [text, setText] = useState(q);
  useEffect(() => setText(q), [q]);
  useEffect(() => {
    if (text === q) return;
    const id = setTimeout(() => onQuery(text.trim()), 250);
    return () => clearTimeout(id);
  }, [text]);

  const total = board.rows.length;
  const known = provinces.filter((p) => p.province);
  const missing = provinces.find((p) => !p.province);

  return (
    <div className="card flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
      <label className="flex items-center gap-2 text-sm">
        <span className="shrink-0 text-slate-500 dark:text-slate-400">省份</span>
        <select
          className="input min-w-[11rem] cursor-pointer py-1.5 pr-8"
          value={province}
          onChange={(e) => onProvince(e.target.value)}
          aria-label="按省份筛选"
        >
          <option value="">全部省份（{total}）</option>
          {known.map((p) => (
            <option key={p.province} value={p.province}>
              {p.province}（{p.teams}）
            </option>
          ))}
          {missing && <option value={NO_PROVINCE}>未填省份（{missing.teams}）</option>}
        </select>
      </label>

      <label className="relative flex min-w-[14rem] flex-1 items-center sm:max-w-sm">
        <span className="sr-only">搜索</span>
        <svg viewBox="0 0 20 20" className="pointer-events-none absolute left-2.5 size-4 text-slate-400" fill="none" aria-hidden>
          <circle cx="9" cy="9" r="5.5" stroke="currentColor" strokeWidth="1.6" />
          <path d="m13.5 13.5 3 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        <input
          type="search"
          className="input w-full pl-8"
          placeholder="搜索队伍 / 学校 / 导师"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </label>

      <div className="flex flex-wrap items-center gap-2 text-[13px] text-slate-500 dark:text-slate-400">
        {(province || q) && (
          <>
            <span>
              显示 <b className="num text-slate-800 dark:text-slate-100">{shown}</b> / {total} 队
            </span>
            {province && (
              <button type="button" className="chip py-0.5" onClick={() => onProvince('')} title="清除省份筛选">
                {provinceLabel(province)} ✕
              </button>
            )}
            {q && (
              <button type="button" className="chip py-0.5" onClick={() => onQuery('')} title="清除搜索">
                “{q}” ✕
              </button>
            )}
          </>
        )}
      </div>

      <div className="ml-auto flex items-center gap-2">
        <a
          className="btn"
          href={csvUrl(board.id, province)}
          download
          onClick={() => hit({ k: 'csv', t: board.id })}
          title={province ? `导出 ${provinceLabel(province)} 的 ${board.title}` : `导出 ${board.title}`}
        >
          <svg viewBox="0 0 20 20" className="size-4" fill="none" aria-hidden>
            <path d="M10 3v10m0 0-4-4m4 4 4-4M4 16h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          CSV
        </a>
        <a className="btn" href={board.source} target="_blank" rel="noreferrer" onClick={() => hit({ k: 'out', t: board.id })}>
          源站 ↗
        </a>
      </div>
    </div>
  );
}
