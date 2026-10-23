// Bundles src/ into dist/ (index.html, app.js, app.css) for the browser and the Mac app.
import { build } from 'esbuild';
import { mkdir, copyFile, rm } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await build({
  entryPoints: { app: 'src/app.js', term: 'src/term-window.js' },
  bundle: true,
  minify: !process.env.DEV, // DEV=1 node build.mjs → readable stack traces
  format: 'iife',
  target: ['safari15', 'chrome100'],
  outdir: 'dist',
  legalComments: 'none',
  logLevel: 'warning',
});
await copyFile('src/index.html', 'dist/index.html');
await copyFile('src/term.html', 'dist/term.html');
console.log('Built dist/');
