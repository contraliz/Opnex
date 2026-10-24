import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require=createRequire(import.meta.url);const {clampNativeBounds}=require('../desktop/browser-bounds.cjs') as {clampNativeBounds:(rect:{x:number;y:number;width:number;height:number}|null,contentSize:{width:number;height:number})=>{x:number;y:number;width:number;height:number}};

describe('native browser bounds',()=>{
  it('rounds CSS-pixel measurements to Electron content bounds and clips at the right and bottom edges',()=>{
    expect(clampNativeBounds({x:18.4,y:42.6,width:900,height:700},{width:1280,height:720})).toEqual({x:18,y:43,width:900,height:677});
    expect(clampNativeBounds({x:1280,y:720,width:10,height:10},{width:1280,height:720})).toEqual({x:0,y:0,width:0,height:0});
  });
  it('hides invalid, zero-sized, and negative-size rectangles',()=>{
    expect(clampNativeBounds(null,{width:1280,height:720})).toEqual({x:0,y:0,width:0,height:0});
    expect(clampNativeBounds({x:0,y:0,width:-1,height:20},{width:1280,height:720})).toEqual({x:0,y:0,width:0,height:0});
    expect(clampNativeBounds({x:0,y:0,width:20,height:20},{width:Number.NaN,height:720})).toEqual({x:0,y:0,width:0,height:0});
  });
  it('clips rectangles crossing the left and top edges without expanding their right and bottom edges',()=>{
    expect(clampNativeBounds({x:-20,y:-10,width:100,height:80},{width:1280,height:720})).toEqual({x:0,y:0,width:80,height:70});
  });
});
