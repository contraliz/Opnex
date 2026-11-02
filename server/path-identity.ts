import path from 'node:path';

export function pathIdentity(value: string, platform: NodeJS.Platform = process.platform) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const resolved = paths.resolve(value);
  return platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
}

export function samePath(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform
) {
  return pathIdentity(left, platform) === pathIdentity(right, platform);
}

export function normalizePathCase(value: string, platform: NodeJS.Platform = process.platform) {
  return platform === 'win32' ? value.toLocaleLowerCase('en-US') : value;
}
