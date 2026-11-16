/**
 * builtinSource loads the embedded module text with import() on first use,
 * so bundlers split it out; a failed load (a chunk the browser couldn't
 * fetch) is tried again on the next lookup rather than remembered.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModuleSource } from '../src/source/source.js';

async function freshSource(fail: number): Promise<{ builtinSource: ModuleSource; loads: () => number }> {
  vi.resetModules();
  let loads = 0;
  vi.doMock('../src/source/builtin-modules.js', async (importOriginal) => {
    loads++;
    if (fail > 0) {
      fail--;
      throw new Error('Failed to fetch dynamically imported module');
    }
    return importOriginal();
  });
  const { builtinSource } = await import('../src/source/source.js');
  return { builtinSource, loads: () => loads };
}

afterEach(() => {
  vi.doUnmock('../src/source/builtin-modules.js');
  vi.resetModules();
});

describe('builtinSource', () => {
  it('loads the module text on the first lookup, not when imported, and only once', async () => {
    const { builtinSource, loads } = await freshSource(0);
    expect(loads()).toBe(0);
    const [types, inet] = await Promise.all([builtinSource.load('ietf-yang-types'), builtinSource.load('ietf-inet-types')]);
    expect(types?.source).toMatch(/^@node-net\/yang\/modules\/ietf-yang-types@/);
    expect(inet?.source).toMatch(/^@node-net\/yang\/modules\/ietf-inet-types@/);
    expect(await builtinSource.load('no-such-module')).toBeUndefined();
    expect(loads()).toBe(1);
  });

  it('tries again after a failed load', async () => {
    const { builtinSource, loads } = await freshSource(1);
    await expect(builtinSource.load('ietf-yang-types')).rejects.toThrow();
    expect(await builtinSource.load('ietf-yang-types')).toBeDefined();
    expect(loads()).toBe(2);
  });
});
