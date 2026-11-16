import { describe, expect, it } from 'vitest';
import { compileXsdRegex, XsdRegexError } from '../../src/index.js';

const matches = (pattern: string, value: string): boolean => compileXsdRegex(pattern).test(value);

describe('XSD regular expressions', () => {
  it('are anchored at both ends', () => {
    expect(matches('abc', 'abc')).toBe(true);
    expect(matches('abc', 'xabcx')).toBe(false);
    expect(matches('a|b', 'ab')).toBe(false);
  });

  it('treat ^ and $ as ordinary characters', () => {
    expect(matches('^a$', '^a$')).toBe(true);
    expect(matches('^a$', 'a')).toBe(false);
  });

  it('let . match anything except line breaks', () => {
    expect(matches('.', '\t')).toBe(true);
    expect(matches('.', '😀')).toBe(true);
    expect(matches('.', '\n')).toBe(false);
    expect(matches('.', '\r')).toBe(false);
  });

  it('give \\s, \\d and \\w their XSD meanings', () => {
    expect(matches('\\s', ' ')).toBe(false); // JavaScript's \s would match NBSP
    expect(matches('\\s+', ' \t\r\n')).toBe(true);
    expect(matches('\\d', '٣')).toBe(true); // ARABIC-INDIC DIGIT THREE
    expect(matches('\\w', 'é')).toBe(true);
    expect(matches('\\w', '-')).toBe(false);
    expect(matches('\\W', ' ')).toBe(true);
  });

  it('support XML name characters \\i and \\c', () => {
    expect(matches('\\i\\c*', 'a-b.c')).toBe(true);
    expect(matches('\\i\\c*', '1abc')).toBe(false);
    expect(matches('\\I', '1')).toBe(true);
  });

  it('support Unicode categories', () => {
    expect(matches('\\p{Lu}+', 'ABC')).toBe(true);
    expect(matches('\\P{L}', 'a')).toBe(false);
  });

  it('support character class subtraction', () => {
    expect(matches('[a-z-[aeiou]]+', 'bcd')).toBe(true);
    expect(matches('[a-z-[aeiou]]', 'e')).toBe(false);
    expect(matches('[^0-9-[5]]', '5')).toBe(true);
  });

  it('handle quantifiers, groups and escapes', () => {
    expect(matches('(ab){2,3}', 'ababab')).toBe(true);
    expect(matches('(ab){2,3}', 'ab')).toBe(false);
    expect(matches('a{2}', 'aa')).toBe(true);
    expect(matches('a{2,}', 'aaaa')).toBe(true);
    expect(matches('\\.\\*\\?\\[\\]', '.*?[]')).toBe(true);
    expect(matches('[\\-a]+', '-a-')).toBe(true);
    expect(matches('[a-]', '-')).toBe(true);
    expect(matches('[-a]', '-')).toBe(true);
  });

  it('handle real patterns from IETF modules', () => {
    // ietf-inet-types ipv4-address (no zone)
    const ipv4 = '(([0-9]|[1-9][0-9]|1[0-9][0-9]|2[0-4][0-9]|25[0-5])\\.){3}([0-9]|[1-9][0-9]|1[0-9][0-9]|2[0-4][0-9]|25[0-5])(%[\\p{N}\\p{L}]+)?';
    expect(matches(ipv4, '192.168.0.1')).toBe(true);
    expect(matches(ipv4, '192.168.0.256')).toBe(false);
    // ietf-yang-types date-and-time
    const dt = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[\\+\\-]\\d{2}:\\d{2})';
    expect(matches(dt, '2026-11-09T12:00:00.5+13:00')).toBe(true);
    expect(matches(dt, '2026-11-09 12:00:00Z')).toBe(false);
  });

  it.each([
    ['[a-', "unterminated character class: missing ']'"],
    ['(a', "missing ')'"],
    ['a)', "unexpected ')'"],
    ['*a', "'*' has nothing to repeat"],
    ['a{,2}', "a quantifier needs a minimum, as in '{2,}'"],
    ['a{3,2}', 'a quantifier maximum is less than its minimum'],
    ['\\q', "'\\q' is not a valid escape"],
    ['\\p{Xx}', "'Xx' is not a Unicode category"],
    ['\\p{IsBasicLatin}', "Unicode block escapes such as '\\p{IsBasicLatin}' are not supported yet"],
    ['[z-a]', 'a range is out of order'],
    ['[a-b-c]', "'-' must be escaped in the middle of a character class"],
    ['a\\', 'pattern ends with a backslash'],
  ])('rejects %j', (pattern, message) => {
    expect(() => compileXsdRegex(pattern)).toThrow(XsdRegexError);
    expect(() => compileXsdRegex(pattern)).toThrow(message);
  });
});
