import { describe, expect, it } from 'vitest';
import { browserAddressSuggestions, normalizeBrowserAddress } from '../src/ui/browser-address.js';

describe('browser address entry',()=>{
  it('adds HTTPS to bare hostnames and keeps explicit HTTP for local fixtures',()=>{
    expect(normalizeBrowserAddress('example.com')).toBe('https://example.com/');
    expect(normalizeBrowserAddress('localhost:4173/fixture')).toBe('https://localhost:4173/fixture');
    expect(normalizeBrowserAddress('http://127.0.0.1:4173/fixture')).toBe('http://127.0.0.1:4173/fixture');
    expect(normalizeBrowserAddress('https://github.com/openai/codex')).toBe('https://github.com/openai/codex');
  });
  it('rejects blank addresses, unsupported schemes, and credentials in URLs',()=>{
    expect(()=>normalizeBrowserAddress('  ')).toThrow('Enter a website address');
    expect(()=>normalizeBrowserAddress('file:///C:/secret.txt')).toThrow('Only HTTP and HTTPS');
    expect(()=>normalizeBrowserAddress('https://user:pass@example.com')).toThrow('contain credentials');
  });
  it('offers matching common destinations and all destinations for an empty query',()=>{
    expect(browserAddressSuggestions('github').map(item=>item.label)).toEqual(['GitHub','GitHub device sign-in']);
    expect(browserAddressSuggestions('')).toHaveLength(6);
  });
});
