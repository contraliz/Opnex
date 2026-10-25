import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

type UriComponents={scheme?:string;host?:string;path?:string;error?:string};
interface FastUri {
  parse(uri:string,options?:{reference?:string}):UriComponents;
  normalize(uri:string,options?:{reference?:string}):string;
  normalize(uri:UriComponents,options?:{reference?:string}):UriComponents;
  resolve(base:string,relative:string,options?:{reference?:string}):string;
  equal(left:string,right:string,options?:{reference?:string}):boolean;
  serialize(components:UriComponents,options?:{reference?:string}):string;
}

const requireFromProject=createRequire(import.meta.url);
const sdkEntry=requireFromProject.resolve('@modelcontextprotocol/sdk/client/index.js');
const ajvEntry=createRequire(sdkEntry).resolve('ajv');
const fastUri=createRequire(ajvEntry)('fast-uri') as FastUri;

function attempt<T>(action:()=>T):T|undefined{try{return action();}catch{return undefined;}}

describe('MCP SDK URI dependency security regressions',()=>{
  it('does not turn percent-encoded or legacy-escaped schemes into live dangerous schemes',()=>{
    const cases=[
      {input:'%6Aavascript:alert(1)',scheme:'javascript',plain:'javascript:alert(1)'},
      {input:'%u006Aavascript:alert(1)',scheme:'javascript',plain:'javascript:alert(1)'},
      {input:'%64ata:text/html,boom',scheme:'data',plain:'data:text/html,boom'}
    ];
    for(const item of cases){
      expect(attempt(()=>fastUri.normalize(item.input))).not.toBe(item.plain);
      expect(attempt(()=>fastUri.resolve('https://a.example/',item.input))).not.toBe(item.plain);
      const parsed=attempt(()=>fastUri.parse(item.input));
      expect(parsed===undefined||Boolean(parsed.error)||parsed.scheme?.toLowerCase()!==item.scheme).toBe(true);
      expect(attempt(()=>fastUri.equal(item.input,item.plain))).not.toBe(true);
    }
  });

  it('rejects ambiguous and control-character HTTP hosts instead of silently rewriting them',()=>{
    const inputs=[
      'http://a@b@evil.example/',
      'http://safe\t.example/',
      'http://safe\r.example/',
      'http://safe\n.example/'
    ];
    for(const input of inputs){
      const parsed=attempt(()=>fastUri.parse(input));
      expect(parsed===undefined||Boolean(parsed.error)).toBe(true);
      expect(attempt(()=>fastUri.resolve('https://base.example/',input))).toBeUndefined();
    }
  });

  it('preserves relative-reference resolution when normalized first',()=>{
    const base='https://a.example/dir/file';
    for(const reference of ['../x','a/../b']){
      const normalized=fastUri.normalize(reference);
      expect(fastUri.resolve(base,normalized)).toBe(fastUri.resolve(base,reference));
    }
    expect(fastUri.resolve(base,'../x')).toBe('https://a.example/x');
  });

  it('escapes a suffix reference first-segment colon before it can become a scheme',()=>{
    const pathOnly={path:'javascript:alert(1)'};
    const serialized=fastUri.serialize(pathOnly,{reference:'suffix'});
    expect(serialized).toBe('javascript%3Aalert(1)');
    expect(new URL(serialized,'https://a.example/base').protocol).toBe('https:');

    const normalized=fastUri.normalize(pathOnly,{reference:'suffix'}) as UriComponents;
    expect(normalized.scheme).toBeUndefined();

    const resolved=fastUri.resolve('https://a.example/base','javascript:alert(1)',{reference:'suffix'});
    expect(new URL(resolved,'https://a.example/base').protocol).toBe('https:');
  });

  it('keeps ordinary absolute and relative references canonical',()=>{
    expect(fastUri.normalize('HTTPS://EXAMPLE.COM/a/../b')).toBe('https://example.com/b');
    expect(fastUri.resolve('https://a.example/dir/file','../x')).toBe('https://a.example/x');
    expect(fastUri.normalize('docs/intro')).toBe('docs/intro');
  });
});
