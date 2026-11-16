/**
 * The namespace prefixes in scope at an element being decoded: the element's
 * own declarations over its parent's scope, linked rather than copied, so a
 * document whose elements each declare a prefix under many inherited ones
 * costs memory once per declaration, not once per declaration per element.
 *
 * It is a Map, as the copy was (a yang:key or yang:value annotation keeps it
 * as its `prefixes`). `get` and `has` walk the chain, which is no longer than
 * the element's declaring ancestors. Anything that needs every entry, or
 * changes one, first copies the chain into the Map's own storage, once.
 */

// The Map's own storage, bypassing the overrides below.
const mapSet = (map: Map<string, string>, prefix: string, uri: string): unknown => Map.prototype.set.call(map, prefix, uri);
const mapGet = (map: Map<string, string>, prefix: string): string | undefined => Map.prototype.get.call(map, prefix) as string | undefined;

export class ChainedScope extends Map<string, string> {
  readonly #own: ReadonlyMap<string, string>;
  readonly #parent: ReadonlyMap<string, string>;
  #flat = false;

  constructor(own: ReadonlyMap<string, string>, parent: ReadonlyMap<string, string>) {
    super();
    this.#own = own;
    this.#parent = parent;
  }

  override get(prefix: string): string | undefined {
    return ChainedScope.#lookup(this, prefix);
  }

  static #lookup(scope: ChainedScope, prefix: string): string | undefined {
    let s: ReadonlyMap<string, string> = scope;
    while (s instanceof ChainedScope) {
      if (s.#flat) return mapGet(s, prefix);
      const uri = s.#own.get(prefix);
      if (uri !== undefined) return uri;
      s = s.#parent;
    }
    return s.get(prefix);
  }

  override has(prefix: string): boolean {
    return this.get(prefix) !== undefined;
  }

  override get size(): number {
    this.#flatten();
    return super.size;
  }

  override entries(): ReturnType<Map<string, string>['entries']> {
    this.#flatten();
    return super.entries();
  }

  override keys(): ReturnType<Map<string, string>['keys']> {
    this.#flatten();
    return super.keys();
  }

  override values(): ReturnType<Map<string, string>['values']> {
    this.#flatten();
    return super.values();
  }

  override [Symbol.iterator](): ReturnType<Map<string, string>['entries']> {
    this.#flatten();
    return super.entries();
  }

  override forEach(callback: (value: string, key: string, map: Map<string, string>) => void, thisArg?: unknown): void {
    this.#flatten();
    super.forEach(callback, thisArg);
  }

  override set(prefix: string, uri: string): this {
    this.#flatten();
    return super.set(prefix, uri);
  }

  override delete(prefix: string): boolean {
    this.#flatten();
    return super.delete(prefix);
  }

  override clear(): void {
    this.#flatten();
    super.clear();
  }

  /** `util.inspect` reads the Map's storage directly, so fill it first. */
  [Symbol.for('nodejs.util.inspect.custom')](): this {
    this.#flatten();
    return this;
  }

  #flatten(): void {
    if (this.#flat) return;
    const links: ReadonlyMap<string, string>[] = [this.#own];
    let s = this.#parent;
    for (; s instanceof ChainedScope && !s.#flat; s = s.#parent) links.push(s.#own);
    for (const [prefix, uri] of s) mapSet(this, prefix, uri);
    for (let i = links.length - 1; i >= 0; i--) for (const [prefix, uri] of links[i]!) mapSet(this, prefix, uri);
    this.#flat = true;
  }

  static {
    // Shown as the copy was (`Map(2) {…}`) by util.inspect.
    Object.defineProperty(this, 'name', { value: 'Map' });
  }
}
