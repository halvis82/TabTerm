import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, VERSION } from './index.js';

describe('shared', () => {
  it('pins a protocol version the daemon and extension both compile against', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it('exposes a build version', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
