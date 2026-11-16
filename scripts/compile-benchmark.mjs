#!/usr/bin/env node
// Time and size a schema compile, for module sets like a vendor's. Uses the
// built package (npm run build first).
//
//   node --expose-gc scripts/compile-benchmark.mjs <dir>[,<dir>...] <module>[,<module>...] [--runs N]
//   node --expose-gc scripts/compile-benchmark.mjs <dir>[,<dir>...] --all
//
// --keep-statements compiles with keepStatements, to compare the memory a
// schema keeps with and without its parsed statements.
//
// --all implements every module (not submodule) in the directories. It prints
// the compile time of each run, the heap the schema keeps (with --expose-gc),
// peak RSS, the schema node count and the diagnostics by severity and code.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { builtinSource, chainSources, compileSchema, fileSource } from '../dist/index.js';

const args = process.argv.slice(2);
const runsAt = args.indexOf('--runs');
const runs = runsAt === -1 ? 1 : Number(args.splice(runsAt, 2)[1]);
const keepAt = args.indexOf('--keep-statements');
const keepStatements = keepAt !== -1;
if (keepStatements) args.splice(keepAt, 1);
const [dirArg, moduleArg] = args;
if (dirArg === undefined || moduleArg === undefined) {
  console.error('usage: compile-benchmark.mjs <dir>[,<dir>...] (<module>[,<module>...] | --all) [--runs N] [--keep-statements]');
  process.exit(2);
}
const dirs = dirArg.split(',');
const modules =
  moduleArg === '--all'
    ? [
        ...new Set(
          dirs.flatMap((dir) =>
            readdirSync(dir)
              .filter((f) => f.endsWith('.yang') && /^\s*(sub)?module\s/m.exec(readFileSync(join(dir, f), 'utf8'))?.[1] === undefined)
              .map((f) => f.replace(/(@[\d-]+)?\.yang$/, '')),
          ),
        ),
      ]
    : moduleArg.split(',');

const heapMB = () => {
  globalThis.gc?.();
  return Math.round(process.memoryUsage().heapUsed / 2 ** 20);
};

const before = heapMB();
let schema;
const times = [];
for (let i = 0; i < runs; i++) {
  const t = performance.now();
  schema = await compileSchema({ source: chainSources(fileSource(dirs), builtinSource), modules, keepStatements });
  times.push(Math.round(performance.now() - t));
}

let nodes = 0;
const walk = (list) => {
  for (const n of list) {
    nodes++;
    walk(n.children);
  }
};
for (const m of schema.modules.values()) walk([...m.dataNodes, ...m.rpcs, ...m.notifications]);
const diagnostics = {};
for (const d of schema.diagnostics) diagnostics[`${d.severity} ${d.code}`] = (diagnostics[`${d.severity} ${d.code}`] ?? 0) + 1;

console.log(
  JSON.stringify(
    {
      requested: modules.length,
      loaded: schema.allModules.length,
      nodes,
      compileMs: times,
      schemaHeapMB: globalThis.gc === undefined ? 'run with --expose-gc' : heapMB() - before,
      peakRssMB: Math.round(process.resourceUsage().maxRSS / 1024),
      diagnostics,
    },
    null,
    2,
  ),
);
