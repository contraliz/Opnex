import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const codexExecutable=process.env.CODEX_EXECUTABLE||'codex';
const appServerAvailable=spawnSync(codexExecutable,['app-server','generate-json-schema','--help'],{windowsHide:true,stdio:'ignore',timeout:5000}).status===0;

function acceptsImageInput(schema:any,value:Record<string,unknown>){
  const image=schema.definitions.v2.UserInput.oneOf.find((variant:any)=>variant.title==='ImageUserInput');
  if(!image||!image.required.every((key:string)=>key in value))return false;
  const type=image.properties.type;
  if(!type.enum.includes(value.type))return false;
  return image.anyOf.some((variant:any)=>variant.required.every((key:string)=>{
    const property=variant.properties[key];return key in value&&typeof value[key]===(Array.isArray(property.type)?property.type[0]:property.type);
  }));
}

describe('installed Codex app-server image protocol',()=>{
  it.skipIf(!appServerAvailable)('rejects the old image_url field and accepts the generated v2 image url shape',async()=>{
    const temp=await mkdtemp(path.join(tmpdir(),'pseudoharness-image-schema-'));
    try{
      const generated=spawnSync(codexExecutable,['app-server','generate-json-schema','--experimental','--out',temp],{windowsHide:true,stdio:'ignore',timeout:20000});
      expect(generated.status).toBe(0);
      const schema=JSON.parse(await readFile(path.join(temp,'codex_app_server_protocol.schemas.json'),'utf8'));
      const turnStart=schema.definitions.v2.TurnStartParams;
      expect(turnStart.properties.input.items.$ref).toBe('#/definitions/v2/UserInput');
      const oldImage={type:'image',image_url:'data:image/png;base64,iVBORw0KGgo='};
      const acceptedImage={type:'image',url:'data:image/png;base64,iVBORw0KGgo='};
      expect(acceptsImageInput(schema,oldImage)).toBe(false);
      expect(acceptsImageInput(schema,acceptedImage)).toBe(true);
    }finally{
      await rm(temp,{recursive:true,force:true});
    }
  });
});
