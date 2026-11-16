// What portable:check runs, bundled for the browser platform, in a context
// with only web-platform globals (scripts/portable-check.mjs). It imports the
// portable entry only: @node-net/yang/core.

import { builtinSource, chainSources, compileSchema, decodeJson, memorySource, toJson, yangLibraryData } from '../dist/core.js';

const MODULE = `module portable {
  yang-version 1.1;
  namespace "urn:example:portable";
  prefix p;
  import ietf-yang-types { prefix yang; }
  container box {
    leaf blob { type binary; }
    leaf mac { type yang:mac-address; }
  }
}`;

globalThis.portableSmoke = async () => {
  // The import is found in the bundled IETF modules, which need no filesystem.
  const schema = await compileSchema({ source: chainSources(memorySource([MODULE]), builtinSource), modules: ['portable'] });
  const errors = schema.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message);
  const data = { 'portable:box': { blob: 'AQID/w==', mac: '00:11:22:33:44:55' } };
  const roundTrip = toJson(decodeJson(schema, data));
  const library = yangLibraryData(schema)['ietf-yang-library:yang-library'];
  return { errors, roundTrip, contentId: library['content-id'] };
};
