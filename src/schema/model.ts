/**
 * The compiled schema: what the compiler produces and the codecs, queries and
 * validation consume.
 *
 * Everything here is resolved. Groupings are expanded, augments and
 * deviations applied, disabled features removed, typedef chains followed to a
 * built-in type, identities linked, and list keys and leafref targets found.
 */

import type { IfFeatureExpression } from '../grammar/if-feature.js';
import type { YangVersion } from '../grammar/statements.js';
import type { SourceLocation } from '../location.js';
import type { Statement } from '../parse/statement.js';
import type { TypedValue } from '../data/value.js';
import type { XsdRegex } from '../types/xsd-match.js';

export interface CompiledModule {
  readonly name: string;
  readonly revision: string | undefined;
  readonly namespace: string;
  readonly prefix: string;
  readonly yangVersion: YangVersion;
  /**
   * True when the module's data nodes, operations and notifications are part
   * of the schema. Modules that are only imported provide definitions
   * (types, groupings, identities) but no nodes.
   */
  readonly implemented: boolean;
  /** Names of the module's features that are enabled. */
  readonly enabledFeatures: ReadonlySet<string>;
  readonly features: ReadonlyMap<string, Feature>;
  readonly identities: ReadonlyMap<string, Identity>;
  readonly extensions: ReadonlyMap<string, ExtensionDefinition>;
  /** Metadata annotations the module defines with `md:annotation` (RFC 7952), by name. */
  readonly annotations: ReadonlyMap<string, AnnotationDefinition>;
  /** Top-level data nodes defined by this module (not those it adds to other modules by augment). */
  readonly dataNodes: readonly DataNode[];
  readonly rpcs: readonly RpcNode[];
  readonly notifications: readonly NotificationNode[];
  /** Names of the submodules included in this module. */
  readonly submodules: readonly string[];
  /**
   * The submodules included in this module, with their revisions, and their
   * statements when the schema was compiled with `keepStatements`.
   */
  readonly includes: readonly { readonly name: string; readonly revision: string | undefined; readonly statement: Statement | undefined }[];
  /** Names of the implemented modules whose deviations apply to this module's nodes (RFC 8525 `deviation`). */
  readonly deviations: readonly string[];
  /** The module's top-level augments (its submodules' too) that applied, with the nodes each added. */
  readonly augments: readonly AugmentInfo[];
  /**
   * YANG data structures the module defines with `sx:structure` (RFC 8791)
   * or `rc:yang-data` (RFC 8040 §8), by name. They describe data outside
   * any datastore, read and written with the codecs' `structure` tree type.
   */
  readonly structures: ReadonlyMap<string, StructureDefinition>;
  /** The module's `sx:augment-structure` statements that applied, with the nodes each added. */
  readonly structureAugments: readonly AugmentInfo[];
  /** The `module` statement. Undefined unless the schema was compiled with `keepStatements`. */
  readonly statement: Statement | undefined;
}

/** A YANG data structure: `sx:structure` (RFC 8791) or `rc:yang-data` (RFC 8040 §8). */
export interface StructureDefinition {
  readonly module: CompiledModule;
  readonly name: string;
  readonly extension: 'structure' | 'yang-data';
  /**
   * The nodes at the top of the structure's data. For `sx:structure`, one
   * container named after the structure, which RFC 8791 §3 encodes as a
   * container holding the structure's nodes. For `rc:yang-data`, its own
   * data nodes: one container, by RFC 8040 §8.
   */
  readonly nodes: readonly DataNode[];
  readonly status: Status;
  readonly description?: string;
  /** The `sx:structure` or `rc:yang-data` statement. Undefined unless the schema was compiled with `keepStatements`. */
  readonly statement: Statement | undefined;
}

/** A top-level `augment` and what it did. */
export interface AugmentInfo {
  /** The target path as written. */
  readonly path: string;
  readonly target: SchemaNode;
  /** The nodes the augment added to the target, in order. */
  readonly nodes: readonly SchemaNode[];
  /** The `augment` statement. Undefined unless the schema was compiled with `keepStatements`. */
  readonly statement: Statement | undefined;
}

export interface Feature {
  readonly module: CompiledModule;
  readonly name: string;
  readonly enabled: boolean;
  readonly ifFeatures: readonly IfFeatureExpression[];
  readonly status: Status;
  readonly description?: string;
}

export interface Identity {
  readonly module: CompiledModule;
  readonly name: string;
  /** Direct bases. */
  readonly bases: readonly Identity[];
  /** Every identity derived from this one, directly or not. */
  readonly derived: ReadonlySet<Identity>;
  readonly status: Status;
  readonly description?: string;
}

export interface ExtensionDefinition {
  readonly module: CompiledModule;
  readonly name: string;
  /** The argument name, if the extension takes one. */
  readonly argument?: string;
  /** True when the argument is a YIN element rather than an attribute. */
  readonly yinElement: boolean;
}

/** A metadata annotation defined with `md:annotation` (RFC 7952 §3). */
export interface AnnotationDefinition {
  readonly module: CompiledModule;
  readonly name: string;
  /** The annotation's value type. Undefined when the type couldn't be resolved. */
  readonly type: YangType | undefined;
  readonly units?: string;
  readonly status: Status;
  readonly description?: string;
}

/** One use of an extension in a module (`prefix:name argument;`). */
export interface ExtensionInstance {
  /** The module that defines the extension. Undefined when the prefix couldn't be resolved. */
  readonly module: string | undefined;
  readonly name: string;
  readonly argument?: string;
  /** The extension statement, with its substatements. Kept whether or not the schema keeps statements. */
  readonly statement: Statement;
}

export type Status = 'current' | 'deprecated' | 'obsolete';

/** An XPath expression (`must`, `when`) with what is needed to evaluate it later. */
export interface XPathExpression {
  readonly text: string;
  /** Prefix → module name, from the file the expression is written in. */
  readonly prefixes: ReadonlyMap<string, string>;
  readonly location: SourceLocation;
}

/**
 * A `when` condition (RFC 7950 §7.21.5) and the statement it came from,
 * which decides its context node: the node itself for its own `when`, the
 * closest ancestor data node for one from `uses` or `augment`, and for the
 * own `when` of a choice or case.
 */
export interface WhenCondition extends XPathExpression {
  readonly from: 'node' | 'uses' | 'augment';
}

export interface Must extends XPathExpression {
  readonly errorMessage?: string;
  readonly errorAppTag?: string;
}

export type SchemaNodeKind =
  | 'container'
  | 'list'
  | 'leaf'
  | 'leaf-list'
  | 'choice'
  | 'case'
  | 'anydata'
  | 'anyxml'
  | 'rpc'
  | 'action'
  | 'input'
  | 'output'
  | 'notification';

interface NodeBase {
  readonly kind: SchemaNodeKind;
  readonly name: string;
  /** The module whose namespace the node is in. For a node added by augment, the augmenting module. */
  readonly module: CompiledModule;
  readonly parent: SchemaNode | undefined;
  /** Child nodes in schema order. */
  readonly children: readonly SchemaNode[];
  /**
   * Whether the node is configuration. False for state data and for
   * everything inside an operation or notification.
   */
  readonly config: boolean;
  readonly status: Status;
  readonly description?: string;
  readonly reference?: string;
  /**
   * `when` conditions, innermost first. A node can have one of its own and
   * more from the `uses` and `augment` statements that brought it in.
   */
  readonly when: readonly WhenCondition[];
  readonly must: readonly Must[];
  readonly extensions: readonly ExtensionInstance[];
  /**
   * The if-feature expressions that applied to the node, as written: its
   * own, then those of the `uses`, `refine` and `augment` statements that
   * brought it in. All were true, or the node wouldn't be in the schema.
   */
  readonly ifFeatures: readonly string[];
  /** The statement the node was compiled from. Undefined unless the schema was compiled with `keepStatements`. */
  readonly statement: Statement | undefined;
}

export interface ContainerNode extends NodeBase {
  readonly kind: 'container';
  /** The meaning of the container's presence, for a presence container. */
  readonly presence?: string;
}

export interface ListNode extends NodeBase {
  readonly kind: 'list';
  readonly keys: readonly LeafNode[];
  readonly unique: readonly (readonly LeafNode[])[];
  readonly minElements: number;
  readonly maxElements: number | undefined;
  readonly orderedBy: 'system' | 'user';
}

export interface LeafNode extends NodeBase {
  readonly kind: 'leaf';
  readonly type: YangType;
  readonly default?: string;
  /** The default as a typed value, for comparing with data. Absent when there is none or it is invalid. */
  readonly defaultValue?: TypedValue;
  readonly units?: string;
  readonly mandatory: boolean;
  /** True for a list key. */
  readonly isKey: boolean;
}

export interface LeafListNode extends NodeBase {
  readonly kind: 'leaf-list';
  readonly type: YangType;
  readonly defaults: readonly string[];
  /** The defaults as typed values. */
  readonly defaultValues: readonly TypedValue[];
  readonly units?: string;
  readonly minElements: number;
  readonly maxElements: number | undefined;
  readonly orderedBy: 'system' | 'user';
}

export interface ChoiceNode extends NodeBase {
  readonly kind: 'choice';
  readonly children: readonly CaseNode[];
  readonly defaultCase?: CaseNode;
  readonly mandatory: boolean;
}

export interface CaseNode extends NodeBase {
  readonly kind: 'case';
  /** True for a case created by the shorthand of putting a data node directly in a choice. */
  readonly shorthand: boolean;
}

export interface AnydataNode extends NodeBase {
  readonly kind: 'anydata' | 'anyxml';
  readonly mandatory: boolean;
}

export interface RpcNode extends NodeBase {
  readonly kind: 'rpc' | 'action';
  readonly children: readonly [InputNode, OutputNode];
  readonly input: InputNode;
  readonly output: OutputNode;
}

export interface InputNode extends NodeBase {
  readonly kind: 'input' | 'output';
}
export type OutputNode = InputNode;

export interface NotificationNode extends NodeBase {
  readonly kind: 'notification';
}

export type DataNode = ContainerNode | ListNode | LeafNode | LeafListNode | ChoiceNode | AnydataNode;
export type SchemaNode = DataNode | CaseNode | RpcNode | InputNode | NotificationNode;

// ---------------------------------------------------------------------------
// Types

export type BuiltinTypeName =
  | 'binary'
  | 'bits'
  | 'boolean'
  | 'decimal64'
  | 'empty'
  | 'enumeration'
  | 'identityref'
  | 'instance-identifier'
  | 'int8'
  | 'int16'
  | 'int32'
  | 'int64'
  | 'leafref'
  | 'string'
  | 'uint8'
  | 'uint16'
  | 'uint32'
  | 'uint64'
  | 'union';

/** An inclusive interval. For decimal64, bounds are scaled by 10^fraction-digits. */
export interface Interval {
  readonly min: bigint;
  readonly max: bigint;
}

export interface Pattern {
  /** The pattern as written, an XSD regular expression. */
  readonly source: string;
  /** The compiled pattern, anchored, matched in time linear in the value's length. */
  readonly regexp: XsdRegex;
  /** True for `modifier invert-match`: values must not match. */
  readonly invert: boolean;
  readonly errorMessage?: string;
  readonly errorAppTag?: string;
}

export interface EnumItem {
  readonly name: string;
  readonly value: number;
  readonly status: Status;
  readonly description?: string;
}

export interface BitItem {
  readonly name: string;
  readonly position: number;
  readonly status: Status;
  readonly description?: string;
}

export interface Typedef {
  readonly module: CompiledModule;
  readonly name: string;
  readonly type: YangType;
  readonly default?: string;
  readonly units?: string;
  readonly status: Status;
  readonly description?: string;
}

/** A leafref path (RFC 7950 §9.9.2), parsed. */
export interface LeafrefPath {
  readonly text: string;
  readonly absolute: boolean;
  /** Number of leading `..` steps, for a relative path. */
  readonly up: number;
  readonly steps: readonly { readonly prefix?: string; readonly name: string }[];
  readonly prefixes: ReadonlyMap<string, string>;
}

/**
 * A resolved type: the built-in type at the bottom of the typedef chain, with
 * every restriction along the way combined.
 */
export interface YangType {
  /** The type name as written: `string`, `yang:counter32`, `percent`. */
  readonly name: string;
  readonly builtin: BuiltinTypeName;
  /** The typedef this type refers to, if it isn't a built-in type directly. */
  readonly typedef?: Typedef;
  /** Allowed values of a numeric type. Absent: the whole range of the built-in type. */
  readonly range?: readonly Interval[];
  /** Allowed lengths of a string or binary. Absent: any length. */
  readonly length?: readonly Interval[];
  /** Every pattern from the typedef chain. A value must satisfy all of them. */
  readonly patterns: readonly Pattern[];
  readonly fractionDigits?: number;
  readonly enums?: readonly EnumItem[];
  readonly bits?: readonly BitItem[];
  /** Member types of a union, in order. */
  readonly types?: readonly YangType[];
  /** Identityref bases. */
  readonly bases?: readonly Identity[];
  readonly path?: LeafrefPath;
  /** The leaf or leaf-list a leafref points to. Set per leaf, since a path is relative to where it's used. */
  readonly target?: LeafNode | LeafListNode;
  readonly requireInstance?: boolean;
}
