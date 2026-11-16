/**
 * Signatures of the XPath functions YANG expressions may call: the XPath 1.0
 * core library (§4) and YANG's own (RFC 7950 §10). Only `current()` exists
 * in YANG 1.0 (RFC 6020 §6.4.1); the rest of §10 is YANG 1.1.
 */

export interface FunctionSignature {
  readonly min: number;
  readonly max: number;
  /** Defined by YANG 1.1 (RFC 7950 §10), not by XPath or YANG 1.0. */
  readonly yang11?: true;
}

const sig = (min: number, max = min, yang11?: true): FunctionSignature => (yang11 ? { min, max, yang11 } : { min, max });

export const FUNCTIONS: ReadonlyMap<string, FunctionSignature> = new Map([
  // Node-set functions (XPath §4.1).
  ['last', sig(0)],
  ['position', sig(0)],
  ['count', sig(1)],
  ['id', sig(1)],
  ['local-name', sig(0, 1)],
  ['namespace-uri', sig(0, 1)],
  ['name', sig(0, 1)],
  // String functions (§4.2).
  ['string', sig(0, 1)],
  ['concat', sig(2, Infinity)],
  ['starts-with', sig(2)],
  ['contains', sig(2)],
  ['substring-before', sig(2)],
  ['substring-after', sig(2)],
  ['substring', sig(2, 3)],
  ['string-length', sig(0, 1)],
  ['normalize-space', sig(0, 1)],
  ['translate', sig(3)],
  // Boolean functions (§4.3).
  ['boolean', sig(1)],
  ['not', sig(1)],
  ['true', sig(0)],
  ['false', sig(0)],
  ['lang', sig(1)],
  // Number functions (§4.4).
  ['number', sig(0, 1)],
  ['sum', sig(1)],
  ['floor', sig(1)],
  ['ceiling', sig(1)],
  ['round', sig(1)],
  // YANG (RFC 7950 §10; RFC 6020 §6.4.1 for current).
  ['current', sig(0)],
  ['re-match', sig(2, 2, true)],
  ['deref', sig(1, 1, true)],
  ['derived-from', sig(2, 2, true)],
  ['derived-from-or-self', sig(2, 2, true)],
  ['enum-value', sig(1, 1, true)],
  ['bit-is-set', sig(2, 2, true)],
]);
