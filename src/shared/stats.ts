// 纯数值工具：分位数、中位数、加权分位数、稳健回归、二分查找。
// 无依赖、不分配大对象，浏览器 / Worker / Bun 通用。

/** 已排序数组的分位数（线性插值，q ∈ [0,1]）。空数组返回 NaN。 */
export function quantileSorted(sorted: ArrayLike<number>, q: number): number {
  const n = sorted.length;
  if (!n) return Number.NaN;
  if (n === 1) return sorted[0];
  const pos = Math.min(1, Math.max(0, q)) * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(n - 1, lo + 1);
  const f = pos - lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * f;
}

/** 升序副本 */
export function sortedCopy(arr: ArrayLike<number>): number[] {
  return Array.from(arr).sort((a, b) => a - b);
}

/** 分位数（线性插值）。空数组返回 NaN。 */
export function quantile(arr: ArrayLike<number>, q: number): number {
  return quantileSorted(sortedCopy(arr), q);
}

/** 一次排序取多个分位数 */
export function quantiles(arr: ArrayLike<number>, qs: number[]): number[] {
  const s = sortedCopy(arr);
  return qs.map((q) => quantileSorted(s, q));
}

export function median(arr: ArrayLike<number>): number {
  return quantile(arr, 0.5);
}

export function mean(arr: ArrayLike<number>): number {
  const n = arr.length;
  if (!n) return Number.NaN;
  let s = 0;
  for (let i = 0; i < n; i++) s += arr[i];
  return s / n;
}

/** 中位数绝对偏差（未乘 1.4826） */
export function mad(arr: ArrayLike<number>): number {
  const m = median(arr);
  if (!Number.isFinite(m)) return Number.NaN;
  const dev: number[] = [];
  for (let i = 0; i < arr.length; i++) dev.push(Math.abs(arr[i] - m));
  return median(dev);
}

/**
 * 加权分位数：values 与 weights 一一对应，权重非负。
 * 采用「累计权重中点」插值，等权时与 quantile() 的线性插值一致。
 */
export function weightedQuantile(values: ArrayLike<number>, weights: ArrayLike<number>, q: number): number {
  const n = values.length;
  if (!n) return Number.NaN;
  const idx: number[] = [];
  for (let i = 0; i < n; i++) if (weights[i] > 0 && Number.isFinite(values[i])) idx.push(i);
  if (!idx.length) return Number.NaN;
  if (idx.length === 1) return values[idx[0]];
  idx.sort((a, b) => values[a] - values[b]);
  let total = 0;
  for (const i of idx) total += weights[i];
  // 每个点的位置 = (累计权重 - 自身权重/2) / 总权重，再在相邻点间线性插值
  const target = Math.min(1, Math.max(0, q));
  let cum = 0;
  let prevPos = 0;
  let prevVal = values[idx[0]];
  for (let k = 0; k < idx.length; k++) {
    const w = weights[idx[k]];
    const pos = (cum + w / 2) / total;
    const v = values[idx[k]];
    if (k === 0 && target <= pos) return v;
    if (target <= pos) {
      const f = pos > prevPos ? (target - prevPos) / (pos - prevPos) : 1;
      return prevVal + (v - prevVal) * f;
    }
    cum += w;
    prevPos = pos;
    prevVal = v;
  }
  return prevVal;
}

/**
 * Theil–Sen 稳健斜率：所有点对斜率的中位数；截距 = median(y - slope·x)。
 * n 很大时只取最近的 maxPoints 个点，避免 O(n²) 失控。
 */
export function theilSen(xs: ArrayLike<number>, ys: ArrayLike<number>, maxPoints = 60): { slope: number; intercept: number } | null {
  const n0 = Math.min(xs.length, ys.length);
  if (n0 < 2) return null;
  const from = Math.max(0, n0 - maxPoints);
  const slopes: number[] = [];
  for (let i = from; i < n0; i++) {
    for (let j = i + 1; j < n0; j++) {
      const dx = xs[j] - xs[i];
      if (dx !== 0) slopes.push((ys[j] - ys[i]) / dx);
    }
  }
  if (!slopes.length) return null;
  const slope = median(slopes);
  const res: number[] = [];
  for (let i = from; i < n0; i++) res.push(ys[i] - slope * xs[i]);
  return { slope, intercept: median(res) };
}

/** 升序数组里 ≤ x 的元素个数（upper bound） */
export function countLE(sorted: ArrayLike<number>, x: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 升序数组里 < x 的元素个数（lower bound） */
export function countLT(sorted: ArrayLike<number>, x: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
