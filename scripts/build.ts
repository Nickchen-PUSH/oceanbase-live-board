// 生产构建：Bun 原生打包器（HTML 入口 → 带 hash 的 JS/CSS），产出 dist/client，
// 供 Cloudflare Worker 静态资源（wrangler assets）与 GitHub Pages 使用。
//   bun scripts/build.ts [outdir]
import tailwind from 'bun-plugin-tailwind';
import { rm } from 'node:fs/promises';

export async function buildClient(outdir = 'dist/client') {
  const started = performance.now();
  await rm(outdir, { recursive: true, force: true });
  const result = await Bun.build({
    entrypoints: ['src/web/index.html'],
    outdir,
    target: 'browser',
    minify: true,
    splitting: true,
    sourcemap: 'linked',
    // 相对路径：GitHub Pages 部署在 /<repo>/ 子路径下也能找到资源
    publicPath: './',
    plugins: [tailwind],
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error('build failed');
  }
  const files = result.outputs.map((o) => ({ path: o.path.replace(process.cwd() + '/', ''), kb: o.size / 1024 }));
  for (const f of files) console.log(`  ${f.path.padEnd(48)} ${f.kb.toFixed(1).padStart(8)} KB`);
  console.log(`✔ built ${files.length} files → ${outdir} in ${Math.round(performance.now() - started)} ms`);
  return result;
}

if (import.meta.main) {
  await buildClient(process.argv[2] || undefined);
}
