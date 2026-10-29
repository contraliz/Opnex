const { existsSync, readdirSync } = require('node:fs');
const path = require('node:path');

function findPackagedLauncher(directory, { platform = process.platform, arch = process.arch } = {}) {
  if (!existsSync(directory)) return null;
  if (platform === 'darwin') {
    const architectureDirectory = arch === 'arm64' ? 'mac-arm64' : 'mac';
    const executable = path.join(directory, architectureDirectory, 'Opnex.app', 'Contents', 'MacOS', 'Opnex');
    return existsSync(executable) ? { executable, args: [] } : null;
  }
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (platform === 'win32' && entry.isDirectory() && entry.name === 'win-unpacked') {
      const executable = path.join(candidate, 'Opnex.exe');
      if (existsSync(executable)) return { executable, args: [] };
    }
    if (entry.isDirectory()) {
      const nested = findPackagedLauncher(candidate, { platform, arch });
      if (nested) return nested;
    }
  }
  return null;
}

module.exports = { findPackagedLauncher };
