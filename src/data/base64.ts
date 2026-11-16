/**
 * Base64 (RFC 4648 §4) for YANG's `binary` type, without Node's Buffer, so
 * @node-net/yang/core runs in any runtime. Decoding is as lenient as Buffer's was:
 * characters outside the alphabet (such as whitespace) are skipped, and it
 * stops at padding.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const VALUES = new Int8Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) VALUES[ALPHABET.charCodeAt(i)] = i;
// The URL-safe alphabet's two characters, which Buffer accepted too.
VALUES['-'.charCodeAt(0)] = 62;
VALUES['_'.charCodeAt(0)] = 63;

export function decodeBase64(text: string): Uint8Array {
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let bits = 0;
  let count = 0;
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x3d) break; // '='
    const v = c < 128 ? VALUES[c]! : -1;
    if (v < 0) continue;
    bits = (bits << 6) | v;
    count += 6;
    if (count >= 8) {
      count -= 8;
      out[n++] = (bits >> count) & 0xff;
    }
  }
  return out.slice(0, n);
}

export function encodeBase64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const v = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += ALPHABET[v >> 18]! + ALPHABET[(v >> 12) & 63]! + ALPHABET[(v >> 6) & 63]! + ALPHABET[v & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const v = bytes[i]! << 16;
    out += `${ALPHABET[v >> 18]!}${ALPHABET[(v >> 12) & 63]!}==`;
  } else if (rest === 2) {
    const v = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += `${ALPHABET[v >> 18]!}${ALPHABET[(v >> 12) & 63]!}${ALPHABET[(v >> 6) & 63]!}=`;
  }
  return out;
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
