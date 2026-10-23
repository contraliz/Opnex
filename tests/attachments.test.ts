import { describe, expect, it } from 'vitest';
import { attachmentUserInput, validateAttachments } from '../server/attachments.js';
import { userTaskSchema } from '../server/contracts.js';

describe('validated task attachments',()=>{
  it('accepts supported UTF-8 text, strips paths and forwards content as labeled text',()=>{
    const data=Buffer.from('hello').toString('base64');const files=validateAttachments([{name:'folder\\notes.md',type:'text/markdown',size:5,data}]);
    expect(files[0].name).toBe('notes.md');expect(attachmentUserInput(files).text).toContain('hello');
  });
  it('forwards a signature-checked image as an inline image input',()=>{
    const bytes=Buffer.from('89504e470d0a1a0a','hex');const files=validateAttachments([{name:'pixel.png',type:'image/png',size:bytes.length,data:bytes.toString('base64')}]);
    expect(attachmentUserInput(files).items).toEqual([{type:'image',image_url:`data:image/png;base64,${bytes.toString('base64')}`}]);
  });
  it('rejects unsupported formats, mismatched sizes and excess file counts',()=>{
    const data=Buffer.from('hello').toString('base64');expect(()=>validateAttachments([{name:'secret.pdf',type:'application/pdf',size:5,data}])).toThrow('Unsupported attachment format');expect(()=>validateAttachments([{name:'a.txt',type:'text/plain',size:6,data}])).toThrow('does not match');expect(()=>validateAttachments(Array.from({length:6},(_,i)=>({name:`${i}.txt`,type:'text/plain',size:5,data})))).toThrow();
  });
  it('allows attachment-only requests while rejecting empty submissions',()=>{
    const data=Buffer.from('hello').toString('base64');expect(userTaskSchema.parse({message:'',attachments:[{name:'a.txt',type:'text/plain',size:5,data}]}).message).toBe('');expect(()=>userTaskSchema.parse({message:'  ',attachments:[]})).toThrow('Add a message or attach');
  });
});
