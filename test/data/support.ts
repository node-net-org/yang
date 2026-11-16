import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { builtinSource, chainSources, compileSchema, memorySource, type InstanceNode, type Schema } from '../../src/index.js';

/** YANG modules and sample data shared by the unit tests and scripts/yanglint-oracle.sh. */
export const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'oracle');

/** A schema exercising every built-in type, annotations, augments, choices, operations and notifications. */
export const EX = readFileSync(join(FIXTURES, 'ex.yang'), 'utf8');

export const EX_IDS = readFileSync(join(FIXTURES, 'ex-ids.yang'), 'utf8');

export const EX_AUG = readFileSync(join(FIXTURES, 'ex-aug.yang'), 'utf8');

let cached: Promise<Schema> | undefined;

export function exSchema(): Promise<Schema> {
  cached ??= compileSchema({
    source: chainSources(
      memorySource([
        { text: EX, source: 'ex.yang' },
        { text: EX_IDS, source: 'ex-ids.yang' },
        { text: EX_AUG, source: 'ex-aug.yang' },
      ]),
      builtinSource,
    ),
    modules: ['ex', 'ex-ids', 'ex-aug', 'ietf-netconf-with-defaults'],
  });
  return cached;
}

/** A node's children, or none for a leaf. */
export function kids(n: InstanceNode | undefined): InstanceNode[] {
  return n !== undefined && 'children' in n ? n.children : [];
}
