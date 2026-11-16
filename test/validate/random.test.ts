/**
 * Random documents over vx.yang (scripts/validate-samples.mjs), judged by
 * yanglint in scripts/yanglint-oracle.sh: @node-net/yang must accept exactly those
 * yanglint accepts, and report an error at the path yanglint names. Skipped
 * when the samples haven't been generated.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeJson, validate } from '../../src/index.js';
import { compile } from '../compile/support.js';

const SAMPLES = join(import.meta.dirname, '..', 'corpus', '.cache', 'validate-samples');
const VX = join(import.meta.dirname, '..', 'fixtures', 'validate', 'vx.yang');

describe('validation of random documents, against yanglint', () => {
  it.skipIf(!existsSync(SAMPLES))('agrees on every sample', async () => {
    const schema = await compile([readFileSync(VX, 'utf8')]);
    const samples = readdirSync(SAMPLES).filter((f) => f.endsWith('.json'));
    expect(samples.length).toBeGreaterThan(100);
    const disagreements: string[] = [];
    for (const file of samples) {
      const base = join(SAMPLES, file.replace(/\.json$/, ''));
      const rejected = existsSync(`${base}.rejected`);
      if (!rejected && !existsSync(`${base}.ok`)) continue;
      const errors = validate(decodeJson(schema, JSON.parse(readFileSync(`${base}.json`, 'utf8')))).filter((i) => i.severity === 'error');
      if (errors.length > 0 !== rejected) {
        disagreements.push(`${file}: yanglint ${rejected ? 'rejects' : 'accepts'}, @node-net/yang ${errors.length > 0 ? `reports ${errors.map((e) => e.code).join(', ')}` : 'accepts'}`);
        continue;
      }
      if (!rejected) continue;
      const message = readFileSync(`${base}.rejected`, 'utf8');
      const m = /\((Data|Schema) location "([^"]+)"/.exec(message);
      if (m === null) continue;
      // A schema location has no keys, and names choices and cases.
      const theirs = m[1] === 'Schema' ? m[2]!.replace(/\/how(\/one|\/two)?(?=\/|$)/, '') : m[2]!;
      const paths = errors.flatMap((i) => [i.path, ...(i.nonUnique ?? []).map((p) => p.slice(0, p.lastIndexOf(']') + 1))]);
      const ours = paths.map((p) => (m[1] === 'Schema' ? p.replace(/\[[^\]]*\]/g, '') : p));
      if (!ours.some((p) => p === theirs || theirs.startsWith(`${p}[`))) disagreements.push(`${file}: yanglint reports ${theirs}, @node-net/yang ${ours.join(', ')}`);
    }
    expect(disagreements).toEqual([]);
  });
});
