import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { builtinSource, chainSources, memorySource, type ModuleSource } from '../../src/index.js';

export const LIBRARY = join(import.meta.dirname, '..', 'fixtures', 'library');
export const CACHE = join(import.meta.dirname, '..', 'corpus', '.cache');
const STD = join(CACHE, 'yangmodels', 'standard');

/** The corpus files test/fixtures/library/modules.txt names. */
const CORPUS_FILES = readFileSync(join(LIBRARY, 'modules.txt'), 'utf8')
  .split('\n')
  .filter((l) => l.trim() !== '' && !l.startsWith('#'))
  .map((l) => join(STD, l.trim()));

let corpusPresent: boolean | undefined;
/** True when the corpus has been fetched (scripts/fetch-corpus.sh). */
export function hasCorpus(): boolean {
  if (corpusPresent === undefined) {
    try {
      for (const f of CORPUS_FILES) readFileSync(f);
      corpusPresent = true;
    } catch {
      corpusPresent = false;
    }
  }
  return corpusPresent;
}

/** Exactly the modules the library fixtures use (as yanglint sees them), then the bundled ones. */
export function librarySource(): ModuleSource {
  const fixtures = readdirSync(LIBRARY)
    .filter((f) => f.endsWith('.yang'))
    .map((f) => ({ text: readFileSync(join(LIBRARY, f)), source: f }));
  const corpus = CORPUS_FILES.map((f) => ({ text: readFileSync(f), source: f }));
  return chainSources(memorySource([...fixtures, ...corpus]), builtinSource);
}

export const readFixture = (name: string): string => readFileSync(join(LIBRARY, name), 'utf8');
