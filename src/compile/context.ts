/**
 * State shared by the compiler phases: compiled module records, lexical
 * scopes and name lookup, features, identities, extensions, and diagnostics.
 */

import type { YangVersion } from '../grammar/statements.js';
import { parseIfFeature, type IfFeatureExpression } from '../grammar/if-feature.js';
import type { Diagnostic, Severity, SourceLocation } from '../location.js';
import { isExtension, substatement, substatements, type Statement } from '../parse/statement.js';
import type {
  StructureDefinition,
  AugmentInfo,
  AnnotationDefinition,
  CompiledModule,
  DataNode,
  ExtensionDefinition,
  ExtensionInstance,
  Feature,
  Identity,
  NotificationNode,
  RpcNode,
  Status,
  WhenCondition,
  XPathExpression,
  Must,
  YangType,
} from '../schema/model.js';
import type { LoadedFile, LoadedModule } from './loader.js';
import { latestRevision } from '../source/source.js';
import { lessCurrent, statusReference, type StatusParty } from '../schema/status.js';

export type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export interface MutableModule extends Mutable<CompiledModule> {
  enabledFeatures: Set<string>;
  features: Map<string, Feature>;
  identities: Map<string, Identity>;
  extensions: Map<string, ExtensionDefinition>;
  annotations: Map<string, AnnotationDefinition>;
  dataNodes: DataNode[];
  deviations: string[];
  augments: AugmentInfo[];
  structures: Map<string, StructureDefinition>;
  structureAugments: AugmentInfo[];
  rpcs: RpcNode[];
  notifications: NotificationNode[];
}

/** A lexical scope: a file, and the chain of statements enclosing the current one in that file. */
export interface Scope {
  readonly file: LoadedFile;
  readonly statement?: Statement;
  readonly parent?: Scope;
}

/** A top-level or nested definition (typedef, grouping) found by lookup, with the scope it was defined in. */
export interface Definition {
  readonly statement: Statement;
  /** The scope enclosing the definition: lookups inside it start here. */
  readonly scope: Scope;
}

interface ModuleDefinitions {
  typedefs: Map<string, Definition>;
  groupings: Map<string, Definition>;
}

const REF = /^(?:([A-Za-z_][A-Za-z0-9_.-]*):)?([A-Za-z_][A-Za-z0-9_.-]*)$/;

export function splitRef(ref: string): { prefix: string | undefined; name: string } | undefined {
  const m = REF.exec(ref);
  return m === null ? undefined : { prefix: m[1], name: m[2]! };
}

export function statusOf(statement: Statement): Status {
  const s = substatement(statement, 'status')?.argument;
  return s === 'deprecated' || s === 'obsolete' ? s : 'current';
}

/** Statements whose `status` is a definition's own, for naming the referring definition in messages. */
const DEFINING = new Set([
  'container', 'leaf', 'leaf-list', 'list', 'choice', 'case', 'anydata', 'anyxml', 'grouping', 'uses', 'augment',
  'typedef', 'identity', 'feature', 'rpc', 'action', 'notification', 'input', 'output', 'enum', 'bit', 'refine',
]);

/**
 * A statement's effective status: the least current `status` on it or on
 * any statement of its lexical scope (see schema/status.ts).
 */
export function lexicalStatus(at: Statement, scope?: Scope): Status {
  let status = statusOf(at);
  for (let s = scope; s?.statement !== undefined && status !== 'obsolete'; s = s.parent) status = lessCurrent(status, statusOf(s.statement));
  return status;
}

/** The referring side of a status reference written at `at`, in `scope`: the nearest enclosing definition. */
export function referrer(at: Statement, scope: Scope | undefined, file: LoadedFile): StatusParty {
  let def: Statement | undefined = DEFINING.has(at.keyword) ? at : undefined;
  for (let s = scope; def === undefined && s?.statement !== undefined; s = s.parent) if (DEFINING.has(s.statement.keyword)) def = s.statement;
  def ??= at;
  return { status: lexicalStatus(at, scope), module: file.module.name, describe: `${def.keyword} '${def.argument ?? ''}'` };
}

/** Adds description and reference to an object being built, when present. */
export function docOf(statement: Statement): { description?: string; reference?: string } {
  const out: { description?: string; reference?: string } = {};
  const d = substatement(statement, 'description')?.argument;
  const r = substatement(statement, 'reference')?.argument;
  if (d !== undefined) out.description = d;
  if (r !== undefined) out.reference = r;
  return out;
}

export class CompileContext {
  readonly diagnostics: Diagnostic[] = [];
  readonly compiled = new Map<string, MutableModule>();
  readonly #definitions = new Map<string, ModuleDefinitions>();
  readonly #featureState = new Map<Feature, 'evaluating' | boolean>();
  readonly #featureEnabledByUser = new Map<string, Set<string> | undefined>();
  /** The file each module-level identity/feature/extension statement came from. */
  readonly fileOf = new Map<Statement, LoadedFile>();
  /** Resolved types of `type` statements, which depend only on their lexical position. */
  readonly typeCache = new Map<Statement, YangType | null>();

  constructor(
    readonly loaded: ReadonlyMap<string, LoadedModule>,
    features: Readonly<Record<string, readonly string[]>> | undefined,
    readonly importOnlyFeatures = true,
  ) {
    for (const [name, list] of Object.entries(features ?? {})) this.#featureEnabledByUser.set(name, new Set(list));
  }

  report(severity: Severity, code: string, message: string, location: SourceLocation): void {
    this.diagnostics.push({ severity, code, message, location });
  }

  error(code: string, message: string, at: Statement): void {
    this.report('error', code, message, at.location);
  }

  warning(code: string, message: string, at: Statement): void {
    this.report('warning', code, message, at.location);
  }

  /** Creates the compiled record of every loaded module and indexes its top-level definitions. */
  createModules(): void {
    for (const m of this.loaded.values()) {
      const module: MutableModule = {
        name: m.name,
        revision: m.revision,
        namespace: m.namespace,
        prefix: m.prefix,
        yangVersion: m.yangVersion,
        implemented: m.implemented,
        enabledFeatures: new Set(),
        features: new Map(),
        identities: new Map(),
        extensions: new Map(),
        annotations: new Map(),
        dataNodes: [],
        rpcs: [],
        notifications: [],
        submodules: m.files.filter((f) => f.isSubmodule).map((f) => f.name),
        includes: m.files.filter((f) => f.isSubmodule).map((f) => ({ name: f.name, revision: latestRevision(substatements(f.statement, 'revision').map((r) => r.argument ?? '')), statement: f.statement })),
        deviations: [],
        augments: [],
        structures: new Map(),
        structureAugments: [],
        statement: m.statement,
      };
      this.compiled.set(m.key, module);
      this.#keys.set(module, m.key);
      const defs: ModuleDefinitions = { typedefs: new Map(), groupings: new Map() };
      this.#definitions.set(m.key, defs);
      for (const file of m.files) {
        const scope: Scope = { file };
        for (const s of file.statement.substatements) {
          if (s.argument === undefined) continue;
          if (s.keyword === 'typedef' || s.keyword === 'grouping') {
            const map = s.keyword === 'typedef' ? defs.typedefs : defs.groupings;
            if (map.has(s.argument)) this.error('duplicate-definition', `${s.keyword} '${s.argument}' is already defined in module ${m.name}`, s);
            else map.set(s.argument, { statement: s, scope });
          } else if (s.keyword === 'feature' || s.keyword === 'identity' || s.keyword === 'extension') {
            this.fileOf.set(s, file);
          }
        }
      }
    }
  }

  readonly #keys = new Map<CompiledModule, string>();

  /** A module's key: its name for the primary revision, `name@revision` for another (see loader.ts). */
  keyOf(module: CompiledModule): string {
    return this.#keys.get(module) ?? module.name;
  }

  /** The module a prefix refers to in a file, or the file's own module for no prefix. */
  moduleFor(prefix: string | undefined, file: LoadedFile): MutableModule | undefined {
    const key = prefix === undefined ? file.module.key : file.keys.get(prefix);
    return key === undefined ? undefined : this.compiled.get(key);
  }

  /**
   * Finds a typedef or grouping by reference, searching enclosing scopes first (RFC 7950 §5.5).
   * `at`, the referencing statement, is where a YANG 1.0 visibility warning goes.
   */
  lookup(kind: 'typedef' | 'grouping', ref: string, scope: Scope, at?: Statement): Definition | undefined {
    const parts = splitRef(ref);
    if (parts === undefined) return undefined;
    const own = scope.file.module.key;
    const target = parts.prefix === undefined ? own : scope.file.keys.get(parts.prefix);
    if (target === undefined) return undefined;
    if (target === own) {
      for (let s: Scope | undefined = scope; s?.statement !== undefined; s = s.parent) {
        const found = substatements(s.statement, kind).find((d) => d.argument === parts.name);
        if (found !== undefined) {
          const def = { statement: found, scope: s };
          if (at !== undefined) this.#checkDefinitionStatus(kind, def, scope, at);
          return def;
        }
      }
    }
    const defs = this.#definitions.get(target);
    const found = (kind === 'typedef' ? defs?.typedefs : defs?.groupings)?.get(parts.name);
    if (found !== undefined && at !== undefined) {
      this.checkVisible(kind, parts.name, found.scope.file, scope.file, at);
      this.#checkDefinitionStatus(kind, found, scope, at);
    }
    return found;
  }

  // ---------------------------------------------------------------------------
  // Status references (RFC 7950 §7.21.2)

  readonly #statusReported = new Set<string>();

  /**
   * Warns when `from` refers to a less current `to`. A reference written in
   * a grouping is resolved again at each use, with the same statement and
   * the same lexical status, so it is reported once.
   */
  checkStatus(from: StatusParty, to: StatusParty, at: SourceLocation): void {
    const problem = statusReference(from, to);
    if (problem === undefined) return;
    const key = `${at.source ?? ''}|${at.offset}|${problem.message}`;
    if (this.#statusReported.has(key)) return;
    this.#statusReported.add(key);
    this.report('warning', problem.code, problem.message, at);
  }

  /** Checks a reference at `at`, in `scope`, to a typedef or grouping. */
  #checkDefinitionStatus(kind: 'typedef' | 'grouping', def: Definition, scope: Scope, at: Statement): void {
    const status = lexicalStatus(def.statement, def.scope);
    if (status === 'current') return;
    const to = { status, module: def.scope.file.module.name, describe: `${kind} '${def.statement.argument ?? ''}'` };
    this.checkStatus(referrer(at, scope, scope.file), to, at.location);
  }

  // ---------------------------------------------------------------------------
  // YANG 1.0 submodule visibility

  /** The file each module-level identity, feature and extension is defined in. */
  readonly #definedIn = new Map<Identity | Feature | ExtensionDefinition, LoadedFile>();
  readonly #visibilityReported = new Map<Statement, Set<string>>();

  /**
   * Warns when a YANG 1.0 file uses a module-level definition from another
   * file of its module that it can't see. In YANG 1.0 a module or submodule
   * sees only its own definitions and those of the submodules it includes
   * itself (RFC 6020 §5.1, §7.2.2), so a submodule never sees the main
   * module's. YANG 1.1 made every definition visible module-wide (RFC 7950
   * §5.1). The definition is used anyway: libyang accepts such modules.
   */
  checkVisible(kind: string, name: string, defined: LoadedFile | undefined, from: LoadedFile, at: Statement): void {
    if (defined === undefined || defined === from || from.yangVersion !== '1' || defined.module !== from.module) return;
    if (defined.isSubmodule && substatements(from.statement, 'include').some((i) => i.argument === defined.name)) return;
    const key = `${kind} ${name}`;
    let reported = this.#visibilityReported.get(at);
    if (reported?.has(key)) return;
    if (reported === undefined) this.#visibilityReported.set(at, (reported = new Set()));
    reported.add(key);
    const where = `${from.statement.keyword} ${from.name}`;
    const message = defined.isSubmodule
      ? `${kind} '${name}' is defined in submodule ${defined.name}, which YANG 1.0 ${where} doesn't include; add 'include ${defined.name};' to ${from.name} (RFC 6020 §5.1)`
      : `${kind} '${name}' is defined in module ${defined.name} itself, which its YANG 1.0 submodule ${from.name} can't see; move it into a submodule that ${from.name} includes, or use yang-version 1.1 (RFC 6020 §5.1)`;
    this.warning('definition-not-included', message, at);
  }

  /** Checks that a module-level identity, feature or extension found from `from` is visible there. */
  #checkDefinition(kind: string, definition: Identity | Feature | ExtensionDefinition, from: LoadedFile, at: Statement): void {
    this.checkVisible(kind, definition.name, this.#definedIn.get(definition), from, at);
  }

  // ---------------------------------------------------------------------------
  // Features

  createFeatures(): void {
    for (const m of this.loaded.values()) {
      const module = this.compiled.get(m.key)!;
      for (const file of m.files) {
        for (const s of substatements(file.statement, 'feature')) {
          if (s.argument === undefined) continue;
          const feature: Mutable<Feature> = {
            module,
            name: s.argument,
            enabled: false,
            ifFeatures: this.#ifFeatureExpressions(s),
            status: statusOf(s),
            ...(docOf(s).description === undefined ? {} : { description: docOf(s).description! }),
          };
          module.features.set(s.argument, feature);
          this.fileOf.set(s, file);
          this.#definedIn.set(feature, file);
          this.#featureStatement.set(feature, s);
        }
      }
      const wanted = this.#featureEnabledByUser.get(m.name);
      for (const name of wanted ?? []) {
        if (!module.features.has(name)) {
          this.report('warning', 'unknown-feature', `feature '${name}' was enabled, but module ${m.name} doesn't define it`, m.statement.location);
        }
      }
    }
    for (const s of this.#featureStatement.values()) this.#checkIfFeatureStatus(s, this.fileOf.get(s)!);
    for (const module of this.compiled.values()) {
      for (const f of module.features.values()) {
        (f as Mutable<Feature>).enabled = this.#featureEnabled(f);
        if (f.enabled) module.enabledFeatures.add(f.name);
      }
    }
  }

  readonly #featureStatement = new Map<Feature, Statement>();

  #featureEnabled(f: Feature): boolean {
    const state = this.#featureState.get(f);
    if (state === 'evaluating') {
      this.error('feature-cycle', `feature '${f.name}' depends on itself through if-feature`, this.#featureStatement.get(f)!);
      return false;
    }
    if (state !== undefined) return state;
    const wanted = this.#featureEnabledByUser.get(f.module.name);
    const implemented = this.loaded.get(this.keyOf(f.module))?.implemented ?? true;
    if ((wanted !== undefined && !wanted.has(f.name)) || (wanted === undefined && !implemented && !this.importOnlyFeatures)) {
      this.#featureState.set(f, false);
      return false;
    }
    this.#featureState.set(f, 'evaluating');
    const s = this.#featureStatement.get(f)!;
    const file = this.fileOf.get(s)!;
    const result = f.ifFeatures.every((e) => this.evaluate(e, file, s));
    this.#featureState.set(f, result);
    return result;
  }

  #ifFeatureExpressions(statement: Statement): IfFeatureExpression[] {
    const out: IfFeatureExpression[] = [];
    for (const s of substatements(statement, 'if-feature')) {
      const e = parseIfFeature(s.argument ?? '');
      if (typeof e !== 'string') out.push(e);
    }
    return out;
  }

  /** Evaluates an if-feature expression written in `file`. Unknown features count as disabled, with an error. */
  evaluate(e: IfFeatureExpression, file: LoadedFile, at: Statement): boolean {
    switch (e.kind) {
      case 'feature': {
        const module = this.moduleFor(e.prefix, file);
        const feature = module?.features.get(e.name);
        if (feature === undefined) {
          this.error('unknown-feature', `feature '${e.prefix === undefined ? '' : `${e.prefix}:`}${e.name}' is not defined`, at);
          return false;
        }
        this.#checkDefinition('feature', feature, file, at);
        return this.#featureEnabled(feature);
      }
      case 'not':
        return !this.evaluate(e.operand, file, at);
      case 'and':
        return this.evaluate(e.left, file, at) && this.evaluate(e.right, file, at);
      case 'or':
        return this.evaluate(e.left, file, at) || this.evaluate(e.right, file, at);
    }
  }

  /**
   * True when every if-feature substatement of `statement` is satisfied.
   * `scope`, the lexical scope enclosing `statement`, gives the status the
   * features it names are compared with.
   */
  enabled(statement: Statement, file: LoadedFile, scope?: Scope): boolean {
    const parsed: { e: IfFeatureExpression; at: Statement }[] = [];
    for (const s of substatements(statement, 'if-feature')) {
      const e = parseIfFeature(s.argument ?? '');
      if (typeof e !== 'string') parsed.push({ e, at: s }); // a string is reported by the grammar check
    }
    if (parsed.length === 0) return true;
    // Every feature named is checked, before evaluation stops at the first false one.
    const inner: Scope = { file, statement, ...(scope === undefined ? {} : { parent: scope }) };
    for (const { e, at } of parsed) this.#checkFeatureStatus(e, file, at, inner);
    return parsed.every(({ e, at }) => this.evaluate(e, file, at));
  }

  /** Checks the status of every feature an if-feature expression names, whatever it evaluates to. */
  #checkFeatureStatus(e: IfFeatureExpression, file: LoadedFile, at: Statement, scope: Scope): void {
    if (e.kind === 'not') this.#checkFeatureStatus(e.operand, file, at, scope);
    else if (e.kind !== 'feature') {
      this.#checkFeatureStatus(e.left, file, at, scope);
      this.#checkFeatureStatus(e.right, file, at, scope);
    } else {
      const feature = this.moduleFor(e.prefix, file)?.features.get(e.name);
      if (feature === undefined || feature.status === 'current') return;
      this.checkStatus(referrer(at, scope, file), { status: feature.status, module: feature.module.name, describe: `feature '${feature.name}'` }, at.location);
    }
  }

  /** Checks the features named in a feature's own if-features. */
  #checkIfFeatureStatus(statement: Statement, file: LoadedFile): void {
    for (const at of substatements(statement, 'if-feature')) {
      const e = parseIfFeature(at.argument ?? '');
      if (typeof e !== 'string') this.#checkFeatureStatus(e, file, at, { file, statement });
    }
  }

  // ---------------------------------------------------------------------------
  // Identities

  createIdentities(): void {
    const pending: { identity: Mutable<Identity> & { derived: Set<Identity> }; statement: Statement; file: LoadedFile }[] = [];
    for (const m of this.loaded.values()) {
      const module = this.compiled.get(m.key)!;
      for (const file of m.files) {
        for (const s of substatements(file.statement, 'identity')) {
          if (s.argument === undefined || !this.enabled(s, file)) continue;
          if (module.identities.has(s.argument)) {
            this.error('duplicate-definition', `identity '${s.argument}' is already defined in module ${m.name}`, s);
            continue;
          }
          const doc = docOf(s);
          const identity = {
            module,
            name: s.argument,
            bases: [] as Identity[],
            derived: new Set<Identity>(),
            status: statusOf(s),
            ...(doc.description === undefined ? {} : { description: doc.description }),
          };
          module.identities.set(s.argument, identity);
          this.#definedIn.set(identity, file);
          pending.push({ identity, statement: s, file });
        }
      }
    }
    for (const { identity, statement, file } of pending) {
      for (const b of substatements(statement, 'base')) {
        const base = this.resolveIdentity(b.argument ?? '', file, b, { file, statement });
        if (base === undefined) this.error('unknown-identity', `base identity '${b.argument ?? ''}' is not defined (or its if-feature is disabled)`, b);
        else (identity.bases as Identity[]).push(base);
      }
    }
    // Derived sets, with cycle detection (RFC 7950 §7.18.2: an identity must not reference itself).
    for (const { identity, statement } of pending) {
      const seen = new Set<Identity>();
      const stack = [...identity.bases];
      while (stack.length > 0) {
        const b = stack.pop()!;
        if (b === identity) {
          this.error('identity-cycle', `identity '${identity.name}' is derived from itself`, statement);
          break;
        }
        if (seen.has(b)) continue;
        seen.add(b);
        (b.derived as Set<Identity>).add(identity);
        stack.push(...b.bases);
      }
    }
  }

  /**
   * Finds an identity by reference from `file`; `at`, the referencing
   * statement, is where a YANG 1.0 visibility warning goes. With `scope`,
   * the lexical scope of a `base` statement, the identity's status is
   * checked against it too.
   */
  resolveIdentity(ref: string, file: LoadedFile, at?: Statement, scope?: Scope): Identity | undefined {
    const parts = splitRef(ref);
    if (parts === undefined) return undefined;
    const identity = this.moduleFor(parts.prefix, file)?.identities.get(parts.name);
    if (identity !== undefined && at !== undefined) {
      this.#checkDefinition('identity', identity, file, at);
      if (scope !== undefined && identity.status !== 'current') {
        this.checkStatus(referrer(at, scope, file), { status: identity.status, module: identity.module.name, describe: `identity '${identity.name}'` }, at.location);
      }
    }
    return identity;
  }

  // ---------------------------------------------------------------------------
  // Extensions

  createExtensions(): void {
    for (const m of this.loaded.values()) {
      const module = this.compiled.get(m.key)!;
      for (const file of m.files) {
        for (const s of substatements(file.statement, 'extension')) {
          if (s.argument === undefined) continue;
          const arg = substatement(s, 'argument');
          const extension: ExtensionDefinition = {
            module,
            name: s.argument,
            ...(arg?.argument === undefined ? {} : { argument: arg.argument }),
            yinElement: substatement(arg ?? s, 'yin-element')?.argument === 'true',
          };
          module.extensions.set(s.argument, extension);
          this.#definedIn.set(extension, file);
        }
      }
    }
  }

  /**
   * Checks every use of an extension of a module's own in its YANG 1.0 files
   * against the 1.0 visibility rule. Extensions are resolved only on schema
   * nodes, so this walks the files instead.
   */
  checkExtensionVisibility(): void {
    for (const m of this.loaded.values()) {
      if (m.files.length < 2) continue;
      const module = this.compiled.get(m.key)!;
      for (const file of m.files) {
        if (file.yangVersion !== '1') continue;
        const walk = (statement: Statement): void => {
          for (const s of statement.substatements) {
            if (isExtension(s) && file.prefixes.get(s.prefix!) === m.name) {
              const extension = module.extensions.get(s.keyword.slice(s.prefix!.length + 1));
              if (extension !== undefined) this.#checkDefinition('extension', extension, file, s);
            }
            walk(s);
          }
        };
        walk(file.statement);
      }
    }
  }

  /** The extension statements directly inside `statement`, resolved. */
  extensionsOf(statement: Statement, file: LoadedFile): ExtensionInstance[] {
    const out: ExtensionInstance[] = [];
    for (const s of statement.substatements) {
      if (!isExtension(s)) continue;
      const module = this.moduleFor(s.prefix, file);
      const name = s.keyword.slice(s.prefix!.length + 1);
      if (module === undefined) {
        this.warning('unknown-prefix', `prefix '${s.prefix!}' of extension ${s.keyword} is not imported`, s);
      } else if (!module.extensions.has(name)) {
        this.warning('unknown-extension', `module ${module.name} does not define extension '${name}'`, s);
      }
      out.push({ module: module?.name, name, ...(s.argument === undefined ? {} : { argument: s.argument }), statement: s });
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // XPath

  /** The YANG version of the file each `must` and `when` is written in, which decides the functions it may call. */
  readonly xpathVersions = new WeakMap<XPathExpression, YangVersion>();

  #xpath<T extends XPathExpression>(x: T, file: LoadedFile): T {
    this.xpathVersions.set(x, file.yangVersion);
    return x;
  }

  #expression(statement: Statement, file: LoadedFile): XPathExpression {
    return { text: statement.argument ?? '', prefixes: file.prefixes, location: statement.argumentLocation ?? statement.location };
  }

  when(statement: Statement, file: LoadedFile, from: WhenCondition['from']): WhenCondition {
    return this.#xpath({ ...this.#expression(statement, file), from }, file);
  }

  mustsOf(statement: Statement, file: LoadedFile): Must[] {
    return substatements(statement, 'must').map((s) => {
      const em = substatement(s, 'error-message')?.argument;
      const tag = substatement(s, 'error-app-tag')?.argument;
      return this.#xpath({ ...this.#expression(s, file), ...(em === undefined ? {} : { errorMessage: em }), ...(tag === undefined ? {} : { errorAppTag: tag }) }, file);
    });
  }
}
