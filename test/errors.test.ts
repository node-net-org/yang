import { describe, expect, it } from 'vitest';
import { NetYangError } from '../src/index.js';

describe('NetYangError', () => {
  it('is an Error with a stable code and keeps its cause', () => {
    const cause = new Error('underlying');
    const err = new NetYangError('failed', { cause });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('NetYangError');
    expect(err.code).toBe('ERR_NET_YANG');
    expect(err.cause).toBe(cause);
  });
});
