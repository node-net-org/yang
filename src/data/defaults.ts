/**
 * Default handling (RFC 6243 with-defaults, on an instance tree).
 *
 * A tree can hold nodes added because of a schema default: their
 * `isDefault` flag is set. {@link addDefaults} adds every default node that
 * applies, and {@link applyWithDefaults} turns a tree into what each
 * retrieval mode reports:
 *
 * - `report-all`: every default node added.
 * - `trim`: leaves whose value is the schema default removed, whether added
 *   or written, and leaf-list entries whose value is one of the defaults.
 * - `explicit`: added configuration defaults removed. Written values are
 *   kept even when they equal the default, and state data defaults are
 *   kept, as RFC 6243 §3.3 reports them.
 * - `report-all-tagged`: as `report-all`, with the `default` annotation on
 *   every leaf and leaf-list entry `trim` would remove.
 *
 * Empty non-presence containers carry no information, so every mode removes
 * them. This follows libyang, with one exception: in trim mode libyang keeps
 * an empty non-presence container that held written leaves.
 *
 * A default guarded by `when` (its own, or one from a `uses`, an `augment`,
 * or a choice or case above it) is added when the condition holds, which may
 * depend on other defaults: conditions are resolved in libyang's order (see
 * src/validate/prepare.ts).
 *
 * The `default` annotation (RFC 6243 §6) is the XML attribute `default` in
 * namespace `urn:ietf:params:xml:ns:netconf:default:1.0`, and in JSON the
 * metadata member `ietf-netconf-with-defaults:default` (RFC 8040 §4.8.9). Both
 * codecs know it without the ietf-netconf-with-defaults module, since its
 * namespace isn't that module's. libyang 2.1 writes it in the module's own
 * namespace; the XML decoder accepts that too.
 */

import type { YangType } from '../schema/model.js';
import { prepare } from '../validate/prepare.js';
import { XPathDocument } from '../xpath/document.js';
import { Evaluator } from '../xpath/evaluate.js';
import { sameValue } from './lexical.js';
import { ContainerInstance, LeafInstance, LeafListEntry, type Annotation, type DataTree, type InnerNode, type InstanceNode } from './tree.js';

export type WithDefaultsMode = 'report-all' | 'report-all-tagged' | 'trim' | 'explicit';

/** The XML namespace of the with-defaults `default` attribute (RFC 6243 §6). */
export const WITH_DEFAULTS_NAMESPACE = 'urn:ietf:params:xml:ns:netconf:default:1.0';
/** The module that names the `default` annotation in JSON (RFC 8040 §4.8.9). */
export const WITH_DEFAULTS_MODULE = 'ietf-netconf-with-defaults';
/** The namespace libyang 2.1 writes the attribute in: the module's, not RFC 6243's. */
export const WITH_DEFAULTS_MODULE_NAMESPACE = 'urn:ietf:params:xml:ns:yang:ietf-netconf-with-defaults';

const BOOLEAN: YangType = { name: 'boolean', builtin: 'boolean', patterns: [] };

/** True for the with-defaults `default` annotation, by XML namespace or JSON module name. */
export function isDefaultAnnotation(namespace: string | undefined, module: string | undefined, name: string): boolean {
  if (name !== 'default') return false;
  return namespace === WITH_DEFAULTS_NAMESPACE || namespace === WITH_DEFAULTS_MODULE_NAMESPACE || (namespace === undefined && module === WITH_DEFAULTS_MODULE);
}

/** The `default` annotation with a value, as the codecs and {@link applyWithDefaults} make it. */
export function defaultAnnotation(value: boolean, prefix?: string): Annotation {
  return {
    namespace: WITH_DEFAULTS_NAMESPACE,
    module: WITH_DEFAULTS_MODULE,
    name: 'default',
    value: { type: BOOLEAN, value },
    ...(prefix === undefined ? {} : { prefix }),
  };
}

/**
 * Whether a leaf or leaf-list entry is default data: added because of a
 * default, or holding the schema default (for a leaf-list entry, one of the
 * defaults).
 */
export function isDefaultValue(node: LeafInstance | LeafListEntry): boolean {
  if (node.isDefault) return true;
  if (node instanceof LeafInstance) return node.schema.defaultValue !== undefined && sameValue(node.value, node.schema.defaultValue);
  return node.schema.defaultValues.some((d) => sameValue(node.value, d));
}

/**
 * Adds every default node that applies and isn't present (RFC 7950 §7.6.1,
 * §7.7.2, §7.9.3): default leaves and leaf-lists, inside existing
 * containers and list entries, in non-presence containers (created when
 * they would hold a default), and in the active case of a choice, or its
 * default case when no case is present. A default whose `when` condition is
 * false is left out. Added nodes have `isDefault` set. State data is left
 * out of a configuration datastore's tree.
 *
 * Changes the tree in place and returns it.
 */
export function addDefaults(tree: DataTree, options: AddDefaultsOptions = {}): DataTree {
  const ev = new Evaluator(new XPathDocument(tree, { operational: options.operational }));
  prepare(tree, ev, { emptyContainers: false });
  return tree;
}

export interface AddDefaultsOptions {
  /**
   * Datastore data that `when` conditions in an RPC, action or notification
   * tree can see (RFC 7950 §6.4.1).
   */
  readonly operational?: DataTree;
}

/**
 * Turns a tree into what a with-defaults retrieval mode reports (RFC 6243
 * §3): adds or removes default nodes and the `default` annotation. Changes
 * the tree in place and returns it.
 */
export function applyWithDefaults(tree: DataTree, mode: WithDefaultsMode): DataTree {
  if (mode !== 'trim') addDefaults(tree);
  const visit = (parent: InnerNode): void => {
    for (const child of [...parent.children]) {
      removeTags(child);
      if (child instanceof LeafInstance || child instanceof LeafListEntry) {
        const dflt = isDefaultValue(child);
        if (mode === 'trim' && dflt) parent.remove(child);
        else if (mode === 'explicit' && child.isDefault && child.schema.config) parent.remove(child);
        else if (mode === 'report-all-tagged' && dflt) child.annotations.push(defaultAnnotation(true));
        continue;
      }
      if ('children' in child) {
        visit(child);
        if (child instanceof ContainerInstance && child.schema.presence === undefined && child.children.length === 0) parent.remove(child);
      }
    }
  };
  visit(tree);
  return tree;
}

function removeTags(node: InstanceNode): void {
  for (let i = node.annotations.length - 1; i >= 0; i--) {
    const a = node.annotations[i]!;
    if (isDefaultAnnotation(a.namespace, a.module, a.name)) node.annotations.splice(i, 1);
  }
}

