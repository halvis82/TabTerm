import { describe, expect, it } from 'vitest';
import {
  parseCompanionRelease,
  compatibilityIssue,
  compareVersions,
  COMPANION_COMPATIBILITY,
} from './updates.js';
const release = () => ({
  schema: 1,
  version: '1.1.0',
  tag: 'v1.1.0',
  commit: 'a'.repeat(40),
  source: {
    url: 'https://github.com/halvis82/TabTerm/releases/download/v1.1.0/tabterm-companion-1.1.0.tar.gz',
    sha256: 'b'.repeat(64),
    bytes: 100,
  },
  compatibility: COMPANION_COMPATIBILITY,
});
describe('companion release contract', () => {
  it('accepts the official source release', () =>
    expect(compatibilityIssue(parseCompanionRelease(release()))).toBeNull());
  it('compares versions numerically', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
    expect(compareVersions('1.1.0', '1.1.0')).toBe(0);
    expect(compareVersions('1.0.2', '1.1.0')).toBe(-1);
  });
  it.each(['1.0.0-beta', '01.0.0', '1.1.0/../x', '999999.1.1'])(
    'rejects malformed version %s',
    (version) => expect(() => parseCompanionRelease({ ...release(), version })).toThrow(),
  );
  it.each([
    'http://github.com/x',
    'https://evil.example/asset',
    'https://github.com/other/project/releases/download/v1.1.0/a',
    'https://github.com/halvis82/TabTerm/releases/download/v1.1.0/../../x',
  ])('rejects untrusted asset %s', (url) =>
    expect(() =>
      parseCompanionRelease({ ...release(), source: { ...release().source, url } }),
    ).toThrow(),
  );
  it('rejects unknown schema, mismatched tag and missing digest', () => {
    expect(() => parseCompanionRelease({ ...release(), schema: 2 })).toThrow();
    expect(() => parseCompanionRelease({ ...release(), tag: 'v1.0.2' })).toThrow();
    expect(() =>
      parseCompanionRelease({ ...release(), source: { ...release().source, sha256: '' } }),
    ).toThrow();
    expect(() =>
      parseCompanionRelease({
        ...release(),
        source: { ...release().source, bytes: 100 * 1024 * 1024 },
      }),
    ).toThrow();
  });
  it.each(['protocol', 'host', 'storage', 'nodeMajor', 'macosMajor'] as const)(
    'requires manual setup for incompatible %s',
    (key) =>
      expect(
        compatibilityIssue(
          parseCompanionRelease({
            ...release(),
            compatibility: { ...COMPANION_COMPATIBILITY, [key]: 99 },
          }),
        ),
      ).not.toBeNull(),
  );
});
