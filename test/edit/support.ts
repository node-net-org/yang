import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyEdit, decodeJson, decodeXml, encodeJson, YangDataError, type DataTree, type EditOptions, type Schema } from '../../src/index.js';
import { compile } from '../compile/support.js';

export const EDIT_FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'edit');

let cached: Promise<Schema> | undefined;
/** The schema of test/fixtures/edit/ed.yang. */
export function edSchema(): Promise<Schema> {
  cached ??= compile([readFileSync(join(EDIT_FIXTURES, 'ed.yang'), 'utf8')]);
  return cached;
}

/** RFC 7951 data, or XML text, as a tree. */
export function data(schema: Schema, content: object | string): DataTree {
  return typeof content === 'string' ? decodeXml(schema, content) : decodeJson(schema, content);
}

/** Edit content, from RFC 7951 JSON or XML text. */
export function edit(schema: Schema, content: object | string): DataTree {
  return typeof content === 'string' ? decodeXml(schema, content, { edit: true }) : decodeJson(schema, content, { edit: true });
}

/** Applies an edit and returns the result as RFC 7951 JSON. */
export function apply(schema: Schema, target: object | string, change: object | string, options: EditOptions = {}): object {
  return encodeJson(applyEdit(data(schema, target), edit(schema, change), options));
}

/** The issue codes and paths an edit fails with. */
export function failure(schema: Schema, target: object | string, change: object | string, options: EditOptions = {}): string[] {
  try {
    applyEdit(data(schema, target), edit(schema, change), options);
  } catch (e) {
    if (e instanceof YangDataError) return e.issues.map((i) => `${i.code} ${i.path}`);
    throw e;
  }
  throw new Error('the edit was applied');
}
