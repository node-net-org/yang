/** An XSD pattern that is invalid, or too large to match safely. */
export class XsdRegexError extends Error {
  override name = 'XsdRegexError';
}
