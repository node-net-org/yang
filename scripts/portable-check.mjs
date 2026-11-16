// @node-net/yang/core must run in any JavaScript runtime. After a build, this:
//
// 1. bundles it for the browser platform with no aliases or externals, and
//    fails on any import that can't be resolved or loaded there;
// 2. runs the bundle in a context with only web-platform globals (no Buffer,
//    process or require): compile a module that imports a bundled IETF
//    module, round-trip binary data, and write YANG library data.
//
//   npm run build && node scripts/portable-check.mjs

import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { rolldown } from 'rolldown';

const entry = fileURLToPath(new URL('./portable-smoke.mjs', import.meta.url));

const problems = [];
let output;
try {
  const bundle = await rolldown({
    input: entry,
    platform: 'browser',
    onLog(level, log) {
      // An import that can't be resolved for the browser is left external with a warning: that is a failure here.
      if (level === 'warn' || log.code === 'UNRESOLVED_IMPORT') problems.push(`${log.code ?? level}: ${log.message}`);
    },
  });
  ({ output } = await bundle.generate({ format: 'iife' }));
  await bundle.close();
} catch (err) {
  problems.push(`bundle failed: ${err.message}`);
}
if (problems.length > 0) fail('@node-net/yang/core does not bundle for the browser', problems);

const code = output[0].code;
const leftovers = [...code.matchAll(/(?:require\(|from\s*)["'](node:[\w/]+)["']/g)].map((m) => m[1]);
if (leftovers.length > 0) fail('the browser bundle still imports Node modules', leftovers);

// Web-platform globals only. The JavaScript built-ins come with the context itself.
const context = vm.createContext({ console, setTimeout, clearTimeout, queueMicrotask, structuredClone, TextEncoder, TextDecoder, URL, atob, btoa });
vm.runInContext(code, context, { filename: 'portable-bundle.js' });
for (const name of ['Buffer', 'process', 'require']) {
  if (vm.runInContext(`typeof ${name}`, context) !== 'undefined') fail(`the check context has ${name}`, []);
}

let result;
try {
  result = await vm.runInContext('portableSmoke()', context);
} catch (err) {
  fail('the smoke run failed without Node globals', [err.stack ?? String(err)]);
}
const expect = (ok, what) => {
  if (!ok) fail(`smoke: ${what}`, [JSON.stringify(result)]);
};
expect(result.errors.length === 0, 'the module compiled against the bundled ietf-yang-types');
expect(result.roundTrip.includes('"blob": "AQID/w=="') || result.roundTrip.includes('"blob":"AQID/w=="'), 'binary data round-trips through base64');
expect(/^[0-9a-f]{16}$/.test(result.contentId), 'the YANG library content-id is computed');

const kib = (Buffer.byteLength(code) / 1024).toFixed(0);
console.log(`portable:check ok: @node-net/yang/core bundles for the browser (${kib} KiB unminified) and runs without Node globals`);

function fail(message, details) {
  console.error(`portable:check: ${message}`);
  for (const d of details) console.error(`  ${d}`);
  process.exit(1);
}
