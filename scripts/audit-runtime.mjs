#!/usr/bin/env node
// The runtime vulnerability gate, the last step of `npm run check`: fails when
// any package's runtime dependency tree (npm audit --omit=dev) has a known
// vulnerability.
//
// Offline, the audit can't run. Then it is skipped with a loud warning and the
// check still passes, so `npm run check` works without a network. Pass
// --require, or set NN_REQUIRE_AUDIT=1, to fail instead: `npm run check:full`
// does, so the gate that matters before landing never goes quiet.
//   node scripts/audit-runtime.mjs [--require]
import { formatCounts, npmAudit } from './npm-audit.mjs';

const required = process.argv.includes('--require') || process.env.NN_REQUIRE_AUDIT === '1';
const result = npmAudit({ omitDev: true });

switch (result.status) {
  case 'ok':
    console.log('audit:runtime: no known vulnerabilities in any runtime dependency tree');
    break;
  case 'vulnerable':
    console.error(`audit:runtime: FAIL: ${result.total} known vulnerabilities in runtime dependencies (${formatCounts(result.counts)})`);
    for (const p of result.packages) console.error(`  ${p.severity.padEnd(9)} ${p.name}${p.direct ? ' (direct)' : ''}`);
    console.error('Run `npm audit --omit=dev` for the advisories, then update (README, "Development").');
    process.exitCode = 1;
    break;
  case 'offline': {
    const lines = [
      'audit:runtime SKIPPED: the npm registry is unreachable, so the runtime',
      'dependency trees were NOT checked for known vulnerabilities.',
      required
        ? 'The audit is required here (--require / NN_REQUIRE_AUDIT=1): FAIL.'
        : 'Run `npm run check:full` (which requires the audit) before landing.',
    ];
    const width = Math.max(...lines.map((l) => l.length));
    const bar = '!'.repeat(width + 4);
    console.error([bar, ...lines.map((l) => `! ${l.padEnd(width)} !`), bar, `npm: ${result.detail}`].join('\n'));
    if (required) process.exitCode = 1;
    break;
  }
  default:
    console.error(`audit:runtime: FAIL: npm audit did not produce a report: ${result.detail}`);
    process.exitCode = 1;
}
