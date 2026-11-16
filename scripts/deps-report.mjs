#!/usr/bin/env node
// The dependency update routine's report (README, "Development"): what is
// outdated, and what the audits find, in one
// summary. It changes nothing.
//   npm run deps:report
// In-range updates (a newer version the package's own range already accepts) are
// listed apart from moves the range doesn't allow, which need a package.json
// edit and more care. Exit status: 0 with a report, 2 if the registry can't be
// reached.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { formatCounts, npmAudit } from './npm-audit.mjs';

const ROOT = resolve(import.meta.dirname, '..');

// Audit first: it fails fast offline, where npm outdated retries for minutes.
const runtime = npmAudit({ omitDev: true });
if (runtime.status === 'offline') {
  console.error(`deps:report: the npm registry is unreachable (${runtime.detail})`);
  process.exit(2);
}
const full = npmAudit({ omitDev: false });

const run = spawnSync('npm', ['outdated', '--json'], {
  cwd: ROOT,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
let outdated;
try {
  outdated = JSON.parse(run.stdout || '{}');
} catch {
  console.error(`deps:report: npm outdated gave no report: ${(run.stderr || run.stdout).trim()}`);
  process.exit(1);
}
if (outdated.error) {
  console.error(`deps:report: npm outdated failed: ${outdated.error.summary ?? JSON.stringify(outdated.error)}`);
  process.exit(1);
}

// npm gives one entry per package, or an array when it is used more than once.
const rows = Object.entries(outdated).flatMap(([name, entries]) =>
  [entries].flat().map((e) => ({ name, workspace: e.dependent ?? '(root)', ...e })),
);
const inRange = rows.filter((r) => r.current !== r.wanted);
const beyond = rows.filter((r) => r.current === r.wanted && r.wanted !== r.latest);

function table(list) {
  const byWorkspace = Map.groupBy(list, (r) => r.workspace);
  for (const [workspace, items] of [...byWorkspace].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  ${workspace}`);
    for (const r of items.sort((a, b) => a.name.localeCompare(b.name))) {
      console.log(`    ${r.name.padEnd(36)} ${String(r.current ?? 'missing').padEnd(12)} wanted ${String(r.wanted).padEnd(12)} latest ${r.latest}`);
    }
  }
}

console.log(`Dependency report, ${new Date().toISOString().slice(0, 10)}\n`);
console.log(`In-range updates (npm update installs these): ${inRange.length}`);
table(inRange);
console.log(`\nNewer than the declared range (needs a package.json change): ${beyond.length}`);
table(beyond);

function auditLine(label, result) {
  if (result.status === 'ok' || result.status === 'vulnerable') {
    console.log(`  ${label.padEnd(9)} ${result.total} (${formatCounts(result.counts)})`);
    for (const p of result.packages) console.log(`      ${p.severity.padEnd(9)} ${p.name}${p.direct ? ' (direct)' : ''}`);
  } else {
    console.log(`  ${label.padEnd(9)} could not run: ${result.detail}`);
  }
}
console.log('\nKnown vulnerabilities');
auditLine('runtime', runtime);
auditLine('all', full);
console.log(
  '\nAct on it with a dependency change, which runs `npm run check:full` before it lands.' +
    ' Runtime findings block every landing (npm run check); development ones are for the next update.',
);
