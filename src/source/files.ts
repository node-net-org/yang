/**
 * Modules read from directories on disk: the one module source that needs
 * Node.js. Only the Node entry (index.ts) exports it; @node-net/yang/core doesn't.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { declaredRevision, type ModuleSource, type ModuleText } from './source.js';

const FILE_NAME = /^([A-Za-z_][A-Za-z0-9_.-]*?)(?:@(\d{4}-\d{2}-\d{2}))?\.(yang|yin)$/;

/**
 * Modules in directories, as `name.yang` or `name@revision.yang` (RFC 7950
 * §5.2), or the same names ending `.yin` (RFC 7950 §13). Directories are searched in order; the first one with a match wins.
 * A `name.yang` without a revision in its file name is parsed to find out
 * which revision it holds.
 */
export function fileSource(directories: readonly string[]): ModuleSource {
  const listings = new Map<string, Promise<string[]>>();
  const list = (dir: string): Promise<string[]> => {
    let l = listings.get(dir);
    if (l === undefined) {
      l = readdir(dir).catch(() => []);
      listings.set(dir, l);
    }
    return l;
  };

  return {
    async load(name, revision) {
      for (const dir of directories) {
        const candidates: { file: string; revision: string | undefined }[] = [];
        for (const file of await list(dir)) {
          const m = FILE_NAME.exec(file);
          if (m?.[1] === name) candidates.push({ file, revision: m[2] });
        }
        if (candidates.length === 0) continue;
        const read = async (file: string): Promise<ModuleText> => ({ text: await readFile(join(dir, file)), source: join(dir, file), format: file.endsWith('.yin') ? 'yin' : 'yang' });

        if (revision !== undefined) {
          const exact = candidates.find((c) => c.revision === revision);
          if (exact !== undefined) return read(exact.file);
          const plain = candidates.find((c) => c.revision === undefined);
          if (plain !== undefined) {
            const text = await read(plain.file);
            if (declaredRevision(text.text) === revision) return text;
          }
          continue;
        }
        const dated = candidates.filter((c) => c.revision !== undefined).sort((a, b) => (a.revision! < b.revision! ? 1 : -1));
        const plain = candidates.find((c) => c.revision === undefined);
        if (plain === undefined) return read(dated[0]!.file);
        const text = await read(plain.file);
        const plainRevision = declaredRevision(text.text);
        if (dated[0] === undefined || (plainRevision !== undefined && plainRevision >= dated[0].revision!)) return text;
        return read(dated[0].file);
      }
      return undefined;
    },
  };
}
