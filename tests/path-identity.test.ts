import { describe, expect, it } from 'vitest';
import { pathIdentity, samePath } from '../server/path-identity.js';

describe('filesystem path identity', () => {
  it('folds case for Windows paths and preserves case for POSIX paths', () => {
    expect(samePath('C:/Repo/File.ts', 'c:/repo/file.ts', 'win32')).toBe(true);
    expect(pathIdentity('/repo/File.ts', 'linux')).not.toBe(pathIdentity('/repo/file.ts', 'linux'));
    expect(samePath('/repo/File.ts', '/repo/file.ts', 'linux')).toBe(false);
  });
});
