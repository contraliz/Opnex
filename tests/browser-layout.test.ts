import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css=readFileSync(new URL('../src/ui/EmbeddedWorkspace.css',import.meta.url),'utf8').replace(/\r\n/g,'\n');

describe('native browser responsive toolbar',()=>{
  it('wraps controls when the Browser pane is narrow and keeps the address field usable',()=>{
    expect(css).toContain('container-name: native-browser-workspace;');
    expect(css).toContain('container-type: inline-size;');
    const narrow=css.match(/@container native-browser-workspace \(max-width: 680px\) \{([\s\S]*?)\n\}/)?.[1]||'';
    expect(narrow).toContain('.native-browser-toolbar { flex-wrap: wrap;');
    expect(narrow).toContain('.native-browser-address { flex: 1 1 250px; min-width: 48px; order: 3; }');
    expect(css).toContain('.native-browser-address-wrap { position: relative; flex: 1 1 auto; min-width: 48px;');
    expect(css).toContain('min-width: 48px;\n  box-sizing: border-box;');
    expect(narrow).toContain('.native-browser-action span { display: none; }');
  });
});
