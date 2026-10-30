import { useId } from 'react';

/** 站点图标（与 src/web/icon.svg 同一份图形）：领奖台 + 海浪 + 实时指示灯 */
export function Logo({ className }: { className?: string }) {
  const id = useId().replace(/:/g, '');
  const bg = `${id}bg`;
  const sea = `${id}sea`;
  const bar = `${id}bar`;
  const clip = `${id}clip`;
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden>
      <defs>
        <linearGradient id={bg} x1="6" y1="2" x2="58" y2="62" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#3d8bff" />
          <stop offset="1" stopColor="#0838b8" />
        </linearGradient>
        <linearGradient id={sea} x1="0" y1="44" x2="0" y2="64" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#5fd3ff" />
          <stop offset="1" stopColor="#1b7cf0" />
        </linearGradient>
        <linearGradient id={bar} x1="0" y1="14" x2="0" y2="52" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#dbe8ff" />
        </linearGradient>
        <clipPath id={clip}>
          <rect width="64" height="64" rx="15" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clip})`}>
        <rect width="64" height="64" fill={`url(#${bg})`} />
        <path d="M-4 6 L64 -4 L64 20 C40 26 18 18 -4 30Z" fill="#fff" opacity=".07" />
        <rect x="11" y="28" width="12" height="28" rx="3.5" fill={`url(#${bar})`} opacity=".86" />
        <rect x="26" y="15" width="12" height="41" rx="3.5" fill={`url(#${bar})`} />
        <rect x="41" y="34" width="12" height="22" rx="3.5" fill={`url(#${bar})`} opacity=".74" />
        <path
          d="M0 49 C6 45.5 11 45.5 16 49 S26 52.5 32 49 S42 45.5 48 49 S58 52.5 64 49 V64 H0Z"
          fill={`url(#${sea})`}
        />
        <path
          d="M0 54.5 C6 51 11 51 16 54.5 S26 58 32 54.5 S42 51 48 54.5 S58 58 64 54.5 V64 H0Z"
          fill="#0b4fd6"
          opacity=".55"
        />
      </g>
      <circle cx="50" cy="14" r="7.5" fill="#34d399" opacity=".28" />
      <circle cx="50" cy="14" r="4.2" fill="#34d399" stroke="#fff" strokeWidth="1.6" />
    </svg>
  );
}
