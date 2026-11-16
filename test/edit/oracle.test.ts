/**
 * The edit engine against sysrepo: scripts/sysrepo-edit-oracle.sh applies
 * the edits of test/fixtures/edit/cases.txt with sysrepocfg --edit and
 * records <running> or the error in test/corpus/.cache/sysrepo-edit. Each
 * case is skipped when its result is absent. Every case is also checked
 * against the outcome cases.txt expects, with or without the oracle.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyEdit, decodeXml, encodeJson, YangDataError } from '../../src/index.js';
import { EDIT_FIXTURES, edSchema } from './support.js';

const OUT = join(import.meta.dirname, '..', 'corpus', '.cache', 'sysrepo-edit');

const CASES = readFileSync(join(EDIT_FIXTURES, 'cases.txt'), 'utf8')
  .split('\n')
  .filter((l) => l.trim() !== '' && !l.startsWith('#'))
  .map((l) => {
    const [name, start, edit, expected] = l.trim().split(/\s+/);
    return { name: name!, start: start!, edit: edit!, expected: expected! };
  });

/**
 * Where @node-net/yang and sysrepo differ on purpose (docs/rfcs.md, M6).
 */
const DIFFERENCES: Record<string, string> = {
  // RFC 6243 §4.5 (basic mode explicit): a leaf the server defaulted doesn't exist to delete. sysrepo deletes nothing and succeeds.
  'delete-default': 'sysrepo accepts deleting a default leaf',
  // RFC 6241 §7.2: deleting what doesn't exist is data-missing. libyang has every non-presence container, so sysrepo succeeds.
  'delete-top': 'sysrepo accepts deleting an empty non-presence container',
  // libyang reads the prefix in yang:value with the schema's prefixes, not the XML namespaces in scope.
  'identity-before': "sysrepo can't map an XML prefix in yang:value",
};

const xml = (name: string): string => readFileSync(join(EDIT_FIXTURES, 'data', `${name}.xml`), 'utf8');

/** RFC 7951 JSON with the ordered-by-system list and leaf-list sorted. */
function normal(json: unknown): unknown {
  const sys = (json as Record<string, Record<string, unknown> | undefined>)['ed:sys'];
  if (sys !== undefined) {
    if (Array.isArray(sys['tag'])) sys['tag'] = [...(sys['tag'] as string[])].sort();
    if (Array.isArray(sys['iface'])) sys['iface'] = [...(sys['iface'] as { name: string; unit: number }[])].sort((a, b) => `${a.name}${a.unit}`.localeCompare(`${b.name}${b.unit}`));
  }
  return json;
}

async function run(start: string, edit: string): Promise<{ json: unknown } | { codes: string[] }> {
  const schema = await edSchema();
  try {
    const target = decodeXml(schema, xml(start));
    const change = decodeXml(schema, xml(edit), { edit: true });
    return { json: normal(encodeJson(applyEdit(target, change, { validate: true }))) };
  } catch (e) {
    if (e instanceof YangDataError) return { codes: e.issues.filter((i) => i.severity === 'error').map((i) => i.code) };
    throw e;
  }
}

describe('the edit engine, against sysrepo', () => {
  for (const c of CASES) {
    it(`${c.name}: ${c.expected}`, async () => {
      const ours = await run(c.start, c.edit);
      if (c.expected === 'ok') expect(ours).toHaveProperty('json');
      else expect(ours).toEqual({ codes: [c.expected] });

      const base = join(OUT, c.name);
      const accepted = existsSync(`${base}.json`);
      if (!accepted && !existsSync(`${base}.rejected`)) return;
      if (c.name in DIFFERENCES) {
        // Recorded so a change in sysrepo shows up.
        expect(accepted, DIFFERENCES[c.name]).toBe(!('json' in ours));
        return;
      }
      expect('json' in ours, accepted ? 'sysrepo accepts it' : `sysrepo rejects it: ${readFileSync(`${base}.rejected`, 'utf8')}`).toBe(accepted);
      if (accepted && 'json' in ours) expect(ours.json).toEqual(normal(JSON.parse(readFileSync(`${base}.json`, 'utf8'))));
    });
  }
});
