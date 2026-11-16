/**
 * @node-net/yang: YANG (RFC 7950) for Node.js.
 *
 * This is the public API: @node-net/yang/core (core.ts, which needs nothing from
 * Node.js) plus fileSource(), which reads modules from directories on disk.
 * The implementation scope and milestones are in docs/rfcs.md.
 */

export * from './core.js';
export { fileSource } from './source/files.js';
