import { describe, expect, it } from 'vitest';
import { authShape } from '../src/api/auth.js';

describe('authShape', () => {
  it.each([
    [undefined, 'none'],
    ['', 'none'],
    ['Bearer abc123', 'bearer'],
    ['bearer abc123', 'bearer'],
    ['Bearer ', 'bearer-malformed'],
    ['Bearer Bearer abc123', 'bearer-malformed'],
    ['Basic dXNlcjpwYXNz', 'other'],
    ['abc123', 'other'],
  ] as const)('%j is %s', (header, shape) => {
    expect(authShape(header)).toBe(shape);
  });
});
