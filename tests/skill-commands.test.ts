import { describe, expect, it } from 'vitest';
import { parseExplicitSkillCommands } from '../server/skill-commands.js';

describe('explicit saved-skill commands',()=>{
  const id='082d966c-c8f5-4e27-92c2-7f03cbf019c0';
  it('extracts only namespaced library IDs from dedicated command lines',()=>{
    expect(parseExplicitSkillCommands(`Explain this.\n/skill library:${id}`)).toEqual([`library:${id}`]);
    expect(parseExplicitSkillCommands(`Explain this.\n/skill library:${id}@${'a'.repeat(64)}`)).toEqual([`library:${id}@${'a'.repeat(64)}`]);
    expect(parseExplicitSkillCommands('Ordinary request mentioning /skill in prose.')).toEqual([]);
    expect(parseExplicitSkillCommands(`/skill library:${id}\n/skill library:${id}`)).toEqual([`library:${id}`]);
  });
  it('rejects ambiguous, malformed and excessive references before routing',()=>{
    expect(()=>parseExplicitSkillCommands('/skill')).toThrow('followed by a saved skill');
    expect(()=>parseExplicitSkillCommands('/skill filesystem-skill')).toThrow('unambiguous');
    expect(()=>parseExplicitSkillCommands('/skill library:../../etc/passwd')).toThrow('unambiguous');
    expect(()=>parseExplicitSkillCommands(Array.from({length:13},(_,i)=>`/skill library:${i.toString(16).padStart(8,'0')}-c8f5-4e27-92c2-7f03cbf019c0`).join('\n'))).toThrow('up to 12');
  });
});
