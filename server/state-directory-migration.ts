import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireStateDirectoryOwner } from './state-owner.js';
import { legacyDataDirectory, stateDirectory } from './paths.js';

export type StateDirectoryMigration = {
  status: 'explicit' | 'unchanged' | 'copied' | 'previously-copied' | 'legacy-preserved';
  current: string;
  legacy?: string;
};

export function migrateLegacyStateDirectory(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
  home = os.homedir(),
  legacyExistsSync: (candidate: string) => boolean = existsSync
): StateDirectoryMigration {
  const current = stateDirectory(env, platform, home);
  if (env.OPNEX_DATA_DIR || env.PSEUDOHARNESS_DATA_DIR) return { status: 'explicit', current };
  if (platform === 'win32') return { status: 'unchanged', current };
  const legacy = legacyDataDirectory({ platform, home, env });
  if (pathKey(current, platform) === pathKey(legacy, platform) || !legacyExistsSync(legacy))
    return { status: 'unchanged', current };
  const legacyStat = lstatSync(legacy);
  if (!legacyStat.isDirectory() || legacyStat.isSymbolicLink())
    throw new Error(
      `The legacy Opnex state path ${legacy} is not a regular directory; it was left untouched.`
    );

  if (existsSync(current)) {
    const currentStat = lstatSync(current);
    if (!currentStat.isDirectory() || currentStat.isSymbolicLink())
      return { status: 'legacy-preserved', current, legacy };
    if (readdirSync(current).length > 0)
      return markerMatches(current)
        ? { status: 'previously-copied', current, legacy }
        : { status: 'legacy-preserved', current, legacy };
  }

  const owner = acquireStateDirectoryOwner(legacy);
  let staging: string | undefined;
  try {
    const parent = path.dirname(current);
    mkdirSync(parent, { recursive: true });
    staging = mkdtempSync(path.join(parent, '.opnex-state-migration-'));
    const copiedDirectory = path.join(staging, path.basename(current));
    cpSync(legacy, copiedDirectory, {
      recursive: true,
      dereference: false,
      filter: (source) => shouldCopyLegacyPath(legacy, source),
    });
    writeFileSync(
      path.join(copiedDirectory, '.opnex-state-migration.json'),
      JSON.stringify({ version: 1, source: 'pseudoharness-to-opnex' }),
      { flag: 'wx', mode: 0o600 }
    );
    if (existsSync(current)) {
      if (!isEmptyDirectory(current)) return { status: 'legacy-preserved', current, legacy };
      rmdirSync(current);
    }
    renameSync(copiedDirectory, current);
    rmSync(staging, { recursive: true, force: true });
    staging = undefined;
    return { status: 'copied', current, legacy };
  } finally {
    owner.release();
    if (staging) rmSync(staging, { recursive: true, force: true });
  }
}

function shouldCopyLegacyPath(root: string, source: string) {
  const relative = path.relative(root, source);
  if (!relative) return true;
  const parts = relative.split(path.sep),
    base = parts.at(-1)?.toLowerCase();
  if (parts.length === 1 && /^agent-codex-home-v\d+$/.test(base || '')) return false;
  return (
    !base?.startsWith('.pseudoharness-owner.sqlite') &&
    base !== '.opnex-state-migration.json' &&
    base !== 'kernel-instance.json'
  );
}

function isEmptyDirectory(directory: string) {
  const stat = lstatSync(directory);
  return stat.isDirectory() && !stat.isSymbolicLink() && readdirSync(directory).length === 0;
}

function markerMatches(directory: string) {
  try {
    const marker = JSON.parse(
      readFileSync(path.join(directory, '.opnex-state-migration.json'), 'utf8')
    );
    return marker.version === 1 && marker.source === 'pseudoharness-to-opnex';
  } catch {
    return false;
  }
}

function pathKey(value: string, platform: string) {
  const resolved = (platform === 'win32' ? path.win32 : path.posix).resolve(value);
  return platform === 'win32' ? resolved.toLocaleLowerCase() : resolved;
}
