/**
 * @node-net/yang/core and the Node entry: core is everything but fileSource(), the
 * bundled modules are embedded (and match modules/), and binary data and the
 * YANG library content-id need nothing from Node.js. portable:check covers
 * the browser bundle and the run without Node globals.
 */
import { readFile } from 'node:fs/promises';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import * as core from '../src/core.js';
import { decodeBase64, encodeBase64, sameBytes } from '../src/data/base64.js';
import * as root from '../src/index.js';
// @ts-expect-error: a plain .mjs build script, untyped.
import { render, TARGET } from '../scripts/gen-builtin-modules.mjs';

describe('@node-net/yang/core', () => {
  it('is the Node entry without fileSource(), and the same objects otherwise', () => {
    expect(core).not.toHaveProperty('fileSource');
    expect(root).toHaveProperty('fileSource');
    for (const [name, value] of Object.entries(core)) expect((root as Record<string, unknown>)[name], name).toBe(value);
  });

  it('finds the bundled modules without a filesystem, by name and by revision', async () => {
    const latest = await core.builtinSource.load('ietf-yang-types');
    expect(latest?.source).toBe('@node-net/yang/modules/ietf-yang-types@2025-12-22.yang');
    const older = await core.builtinSource.load('ietf-yang-types', '2013-07-15');
    expect(older?.source).toBe('@node-net/yang/modules/ietf-yang-types@2013-07-15.yang');
    expect(await core.builtinSource.load('no-such-module')).toBeUndefined();
  });

  it('the embedded modules match modules/*.yang', async () => {
    expect(await readFile(TARGET as string, 'utf8'), 'run node scripts/gen-builtin-modules.mjs').toBe((render as () => string)());
  });
});

describe('base64 for the binary type', () => {
  it('encodes and decodes exactly as Node did', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 300 }), (bytes) => {
        const text = encodeBase64(bytes);
        expect(text).toBe(Buffer.from(bytes).toString('base64'));
        expect(sameBytes(decodeBase64(text), bytes)).toBe(true);
      }),
    );
  });

  it('skips whitespace and other characters, as Buffer did', () => {
    expect([...decodeBase64(' AQ\nID/w = = ')]).toEqual([...Buffer.from(' AQ\nID/w = = ', 'base64')]);
  });
});

describe('the YANG library content-id', () => {
  it('is 16 hex digits, the same for the same module set, and different for another', async () => {
    const source = core.chainSources(core.memorySource(['module a { yang-version 1.1; namespace "urn:a"; prefix a; leaf x { type string; } }']), core.builtinSource);
    const id = async (modules: string[]): Promise<unknown> =>
      core.yangLibraryData(await core.compileSchema({ source, modules }))['ietf-yang-library:yang-library']['content-id'];
    const first = await id(['a']);
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(await id(['a'])).toBe(first);
    expect(await id(['a', 'ietf-yang-types'])).not.toBe(first);
  });
});
