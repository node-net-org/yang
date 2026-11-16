/**
 * Checks what `npm pack` would publish: the compiled library, the bundled IETF
 * modules, the README and the LICENSE, and nothing else (no sources, tests, docs, build-info files, or
 * other workspace packages). Run after `npm run build`.
 */
'use strict';
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts=false'], {
  cwd: path.join(__dirname, '..'),
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'ignore'],
});
// npm prints the prepack/postpack script lines before the JSON on some versions.
const files = JSON.parse(out.slice(out.indexOf('['))).flatMap((p) => p.files.map((f) => f.path));

const required = ['package.json', 'README.md', 'LICENSE', 'dist/index.js', 'dist/index.d.ts', 'modules/README.md', 'modules/ietf-yang-types@2025-12-22.yang'];
const forbidden = [/^src\//, /^test\//, /^scripts\//, /^docs\//, /\.test\.(js|d\.ts)$/, /\.tsbuildinfo$/, /(^|\/)node_modules\//];

const missing = required.filter((f) => !files.includes(f));
const unexpected = files.filter((f) => forbidden.some((re) => re.test(f)));

if (missing.length > 0 || unexpected.length > 0) {
  for (const f of missing) console.error(`missing    ${f}`);
  for (const f of unexpected) console.error(`unexpected ${f}`);
  process.exit(1);
}
console.log(`ok   npm pack: ${files.length} files`);
