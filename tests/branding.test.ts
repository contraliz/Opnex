import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath: string) => readFileSync(path.join(root, relativePath), 'utf8');

describe('Opnex branding and compatibility', () => {
  it('publishes the Opnex package and keeps the old command as an alias', () => {
    const manifest = JSON.parse(read('package.json'));
    const lock = JSON.parse(read('package-lock.json'));
    expect(manifest.name).toBe('opnex');
    expect(manifest.bin).toEqual({ opnex: 'bin/opnex.js', pseudoharness: 'bin/pseudoharness.js' });
    expect(lock.name).toBe('opnex');
    expect(lock.packages[''].name).toBe('opnex');
    expect(manifest.author).toBe('');
  });

  it('uses the Opnex title and supplied favicon in browser builds', () => {
    const html = read('index.html');
    expect(html).toContain('<title>Opnex');
    expect(html).toContain('href="/opnex-icon-grid-1_5-margin.svg"');
    expect(read('public/opnex-icon-grid-1_5-margin.svg')).toBe(read('opnex-icon-grid-1_5-margin.svg'));
    expect(readFileSync(path.join(root, 'public/opnex-icon-grid-1_5-margin.png')))
      .toEqual(readFileSync(path.join(root, 'opnex-icon-grid-1_5-margin.png')));
  });

  it('packages Opnex icons while preserving the installed-app identity', () => {
    const builder = read('electron-builder.yml');
    expect(builder).toContain('productName: Opnex');
    expect(builder).toContain('icon: desktop/opnex.ico');
    expect(builder).toContain('icon: desktop/opnex.icns');
    expect(builder).toContain('appId: org.pseudoharness.desktop');
    expect(builder).toMatch(/appId: org\.pseudoharness\.desktop\r?\n#.*upgrade.*compatibility/i);
    for (const relativePath of ['desktop/opnex.ico', 'desktop/opnex.icns', 'desktop/opnex-tray-icon.png']) {
      expect(() => readFileSync(path.join(root, relativePath))).not.toThrow();
    }
    const generator = read('scripts/generate-brand-icons.ps1');
    expect(generator).toContain("'opnex-icon-grid-1_5-margin.svg'");
    expect(generator).not.toContain("'opnex-icon-grid-1_5-margin.png'");
  });

  it('uses the Opnex GitHub URL in current setup instructions', () => {
    expect(read('README.md')).toContain('https://github.com/contraliz/Opnex.git');
  });
});
