/**
 * The parsed-XML shape the XML codec reads and writes.
 *
 * It is structural on purpose: @node-net/netconf's `XmlElement` satisfies
 * {@link XmlElementLike} as it is, so data that @node-net/netconf has already parsed
 * goes straight to the decoder, and encoder output can become @node-net/netconf
 * elements without serialising to text and parsing again. @node-net/yang's own
 * {@link parseXml} produces plain objects of the same shape.
 */

export interface XmlAttributeLike {
  /** Local name, without prefix. */
  readonly name: string;
  /** Namespace URI, or undefined for an unqualified attribute. */
  readonly ns: string | undefined;
  /** The prefix written in the document, a hint for output. */
  readonly prefix?: string | undefined;
  readonly value: string;
}

export interface XmlElementLike {
  /** Local name, without prefix. */
  readonly name: string;
  /** Namespace URI (`''` for none). Undefined means the parent's namespace. */
  readonly ns?: string | undefined;
  /** The prefix written in the document, a hint for output. */
  readonly prefix?: string | undefined;
  readonly attributes?: readonly XmlAttributeLike[] | undefined;
  /** Child elements and text, in document order. */
  readonly children?: readonly XmlChild[] | undefined;
  /**
   * Namespace declarations made on this element, prefix → URI (`''` for the
   * default namespace). Needed to resolve prefixes inside values, such as
   * identityrefs.
   */
  readonly declarations?: ReadonlyMap<string, string> | undefined;
}

export type XmlChild = XmlElementLike | string;

export function isElement(c: XmlChild): c is XmlElementLike {
  return typeof c !== 'string';
}
