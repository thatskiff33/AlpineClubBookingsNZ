const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');

async function main() {
  const worktree = path.resolve(process.argv[2] || '');
  const expected = '7ce3bb1eaa65e45e32185cefc7af93400ab2d763';
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).trim();
  if (head !== expected) throw new Error(`Expected ${expected}; got ${head}`);
  if (execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: worktree, encoding: 'utf8' }).trim()) throw new Error('Tracked worktree must be clean');
  const req = createRequire(path.join(worktree, 'package.json'));
  const esbuild = req(req.resolve('esbuild', { paths: [path.dirname(req.resolve('tsx'))] }));
  const tailwind = req('@tailwindcss/postcss');
  const postcss = req(req.resolve('postcss', { paths: [path.dirname(req.resolve('@tailwindcss/postcss'))] }));
  const out = path.join(__dirname, 'dist');
  fs.mkdirSync(out, { recursive: true });
  await esbuild.build({
    absWorkingDir: worktree,
    entryPoints: [path.join(__dirname, 'main.tsx')],
    outfile: path.join(out, 'main.js'), bundle: true, platform: 'browser', format: 'iife',
    target: 'es2022', jsx: 'automatic', tsconfig: path.join(worktree, 'tsconfig.json'),
    nodePaths: [path.join(worktree, 'node_modules')],
    alias: {
      'react': req.resolve('react'), 'react/jsx-runtime': req.resolve('react/jsx-runtime'),
      'react-dom': req.resolve('react-dom'), 'react-dom/client': req.resolve('react-dom/client'),
      'next/navigation': path.join(__dirname, 'next-navigation.ts'),
    },
    define: { 'process.env': '{}', 'process.env.NODE_ENV': '"development"', '__UI_SHA__': JSON.stringify(expected) },
    sourcemap: true, logLevel: 'warning',
  });
  const cssPath = path.join(worktree, 'src/app/globals.css');
  const css = fs.readFileSync(cssPath, 'utf8');
  const result = await postcss([tailwind({ base: worktree, optimize: false })]).process(css, { from: cssPath });
  fs.writeFileSync(path.join(out, 'style.css'), result.css);
  fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Private actual component verification</title><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/main.js"></script></body></html>');
  fs.writeFileSync(path.join(out, 'metadata.json'), JSON.stringify({ head, worktree, builtAt: new Date().toISOString(), mocked: ['HTTP data', 'Next navigation'], actual: ['FeesPageClient', 'HutFeesSection', 'FinanceFeesSections', 'PublicBookingRequestsPanel', 'RefundAppealButton', 'MoneyInput', 'ClubFormatProvider', 'ClubTimeProvider', 'ClubIdentityProvider', 'Radix controls', 'production globals.css'] }, null, 2));
  console.log(`Built actual components at ${head} into ${out}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });

