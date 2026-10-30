import { fmtTime } from '../../shared/format.ts';
import { MODE } from '../lib/config.ts';
import { useLive } from '../lib/live.tsx';

export function Footer() {
  const { data } = useLive();
  const st = data?.snap.static;
  return (
    <footer className="mx-auto w-full max-w-[1440px] px-4 pt-8 pb-10 text-xs leading-relaxed text-slate-400 sm:px-6">
      <p>
        数据来自 OceanBase 开放平台公开榜单接口，本站仅做聚合展示，名次与分数以
        <a className="mx-1 text-brand-600 hover:underline" href="https://open.oceanbase.com/competition/armory" target="_blank" rel="noreferrer">
          官方榜单
        </a>
        为准。时间均为北京时间。出分预测基于榜单里每队「最好那次提交」的耗时推算，仅供参考。
      </p>
      {MODE === 'pages' && st && (
        <p className="mt-1">
          静态快照构建于 {fmtTime(st.builtAt)}（{st.builtBy}），实时接口不可用时显示这份数据。
        </p>
      )}
      <p className="mt-1">
        <a className="hover:underline" href="https://github.com/zzstar101/oceanbase-live-board" target="_blank" rel="noreferrer">
          GitHub 源码
        </a>
      </p>
    </footer>
  );
}
