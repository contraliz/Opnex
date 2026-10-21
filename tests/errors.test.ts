import { describe, expect, it } from 'vitest';
import { errorMessage } from '../server/errors.js';

describe('local API error messages',()=>{
  it('converts structured validation issues to concise field guidance',()=>{
    expect(errorMessage({issues:[{path:['projectRoot'],message:'Too small'},{path:['orchestratorEffort'],message:'Invalid option'}]})).toBe('Please check project root: Too small; orchestrator effort: Invalid option.');
  });
  it('uses ordinary error messages and has a readable fallback for unknown values',()=>{
    expect(errorMessage(new Error('Folder access denied.'))).toBe('Folder access denied.');
    expect(errorMessage({})).toContain('Check the supplied information and local service');
  });
});
