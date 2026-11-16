// Runs `npm audit --json` and classifies the result, for audit-runtime.mjs,
// check-full.sh's full audit and deps-report.mjs.
//
// npm reports an unreachable registry as JSON with a top-level `message`
// ("request to … failed, reason: getaddrinfo ENOTFOUND …") and no `metadata`;
// that is the only case classified as offline. Anything else without a report
// is an error, never a pass.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SEVERITIES = ['critical', 'high', 'moderate', 'low', 'info'];
const NETWORK = /request to .* failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH/;

/**
 * @param {{ omitDev: boolean }} options
 * @returns {{ status: 'ok' | 'vulnerable' | 'offline' | 'error', counts?: Record<string, number>,
 *   total?: number, packages?: { name: string, severity: string, direct: boolean }[], detail?: string }}
 */
export function npmAudit({ omitDev }) {
  const args = ['audit', '--json', ...(omitDev ? ['--omit=dev'] : [])];
  const run = spawnSync('npm', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (run.error) return { status: 'error', detail: `could not run npm: ${run.error.message}` };
  let report;
  try {
    report = JSON.parse(run.stdout);
  } catch {
    return { status: 'error', detail: (run.stderr || run.stdout || `npm exited ${run.status}`).trim() };
  }
  if (!report.metadata?.vulnerabilities) {
    const detail = report.message || report.error?.summary || run.stderr.trim() || `npm exited ${run.status}`;
    return { status: NETWORK.test(`${detail}\n${run.stderr}`) ? 'offline' : 'error', detail };
  }
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, report.metadata.vulnerabilities[s] ?? 0]));
  const total = report.metadata.vulnerabilities.total ?? 0;
  const packages = Object.values(report.vulnerabilities ?? {})
    .map((v) => ({ name: v.name, severity: v.severity, direct: Boolean(v.isDirect) }))
    .sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || a.name.localeCompare(b.name));
  return { status: total > 0 ? 'vulnerable' : 'ok', counts, total, packages };
}

/** "0 critical, 1 high, 3 moderate, 0 low" */
export function formatCounts(counts) {
  return SEVERITIES.filter((s) => s !== 'info')
    .map((s) => `${counts[s]} ${s}`)
    .join(', ');
}
