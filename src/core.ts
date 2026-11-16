/**
 * @node-net/yang/core: the whole of @node-net/yang except reading modules from
 * directories on disk. It needs nothing from Node.js, so it runs in any
 * JavaScript runtime; the bundled IETF modules are embedded.
 *
 * The Node entry, @node-net/yang (index.ts), is a superset that adds fileSource().
 * The implementation scope and milestones are in docs/rfcs.md.
 */

export { NetYangError, XPathError, YangDataError, YangSyntaxError, type DataIssue, type NetYangErrorOptions } from './errors.js';
export { formatLocation, type Diagnostic, type Severity, type SourceLocation } from './location.js';

export { parseModule, parseModuleText, type ParsedModule } from './parse/module.js';
export { parseYin, writeYin, YIN_ARGUMENTS, YIN_NAMESPACE, type YinWriteOptions } from './parse/yin.js';
export { writeYang } from './parse/yang-write.js';
export { MAX_DEPTH, type ParseOptions } from './parse/parser.js';
export { isExtension, substatement, substatements, type Statement } from './parse/statement.js';

export { parseIfFeature, type IfFeatureExpression } from './grammar/if-feature.js';
export {
  STATEMENTS,
  type ArgumentKind,
  type Cardinality,
  type StatementRule,
  type SubstatementRule,
  type VersionedCardinality,
  type YangVersion,
} from './grammar/statements.js';

export { compileSchema, type CompileOptions } from './compile/compile.js';
export type { ModuleRequest } from './compile/loader.js';
export { Schema, dataChildren, type DatastoreOptions } from './schema/schema.js';
export type * from './schema/model.js';
export { builtinSource, chainSources, memorySource, type ModuleSource, type ModuleText } from './source/source.js';
export { checkValue, type ValueContext } from './types/value.js';
export { compileXsdRegex, translateXsdRegex, XsdRegexError } from './types/xsd-regex.js';
export { MAX_DFA_STATES, MAX_PATTERN_SIZE, XsdRegex } from './types/xsd-match.js';

export { Decimal64, type InstanceIdentifier, type InstanceIdentifierStep, type TypedValue, type YangValue } from './data/value.js';
export {
  AnyInstance,
  ContainerInstance,
  DataTree,
  LeafInstance,
  LeafListEntry,
  ListEntry,
  OperationInstance,
  type Annotation,
  type AnyContent,
  type InnerNode,
  type InstanceNode,
  type TreeKind,
} from './data/tree.js';
export type { JsonValue } from './data/lexical.js';
export { readJsonValue, writeXmlText, type ReadJsonValueOptions } from './data/value-io.js';
export type { XmlAttributeLike, XmlChild, XmlElementLike } from './xml/element.js';
export type { DecodeOptions } from './data/build.js';
export { decodeXml, type XmlDecodeOptions } from './xml/decode.js';
export { encodeXml, toXml, type XmlEncodeOptions } from './xml/encode.js';
export { parseXml, type PlainElement, type XmlParseOptions } from './xml/parse.js';
export { serializeXml, type XmlSerializeOptions } from './xml/serialize.js';
export { decodeJson, type JsonDecodeOptions } from './json/decode.js';
export { encodeJson, toJson, type JsonEncodeOptions } from './json/encode.js';
export { jsonToXml, xmlToJson } from './convert.js';
export { schemaPath, summarizeType, valuesOf, type NodeInfo, type PathCompletion, type QueryOptions, type TypeSummary } from './schema/query.js';

export {
  decodeYangLibrary,
  fromCapabilities,
  parseModuleCapability,
  readYangLibrary,
  yangLibrarySchema,
  type ImportOnlyModule,
  type LibraryCapability,
  type LibraryDatastore,
  type LibraryModule,
  type LibrarySchema,
  type ModuleCapability,
  type ModuleRef,
  type ModuleSetInfo,
  type YangLibrary,
} from './library/library.js';
export { compileYangLibrary, ServerSchemas, type LibraryCompileOptions } from './library/schemas.js';
export { yangLibraryData, type YangLibraryWriteOptions } from './library/write.js';
export {
  addDefaults,
  applyWithDefaults,
  defaultAnnotation,
  isDefaultValue,
  WITH_DEFAULTS_MODULE,
  WITH_DEFAULTS_NAMESPACE,
  type WithDefaultsMode,
} from './data/defaults.js';
export { mergeTrees } from './data/merge.js';
export { pruneTree, selectionTree, subtreeFilter, type PruneOptions, type SubtreeFilterOptions } from './data/filter.js';
export { treeDiagram, type TreeDiagramOptions } from './schema/diagram.js';
export {
  instanceDataSchema,
  InstanceDataFile,
  readInstanceData,
  writeInstanceData,
  type ContentSchema,
  type InstanceDataHeader,
  type InstanceDataWriteOptions,
} from './library/instance-data.js';

export { parseXPath, MAX_XPATH_DEPTH, MAX_XPATH_LENGTH } from './xpath/parser.js';
export { printXPath } from './xpath/print.js';
export type { Axis, BinaryOperator, Expr as XPathExpr, NodeTest, Step as XPathStep } from './xpath/ast.js';
export { evaluateXPath, type XPathEvaluateOptions } from './xpath/api.js';
export type { XNode } from './xpath/document.js';
export type { XPathValue } from './xpath/evaluate.js';
export { assertValid, validate, type ValidateOptions } from './validate/validate.js';

export { applyEdit, tryApplyEdit, type EditOperation, type EditOptions, type EditResult, type ErrorOption, type TryEditOptions } from './edit/edit.js';
export { diffEdit, diffTrees, editFromChanges, type DataChange, type DiffOptions, type EntryPosition } from './edit/diff.js';
export { effectiveOrigin, type Origin } from './edit/origin.js';
