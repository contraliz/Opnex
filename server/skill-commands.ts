const SKILL_REFERENCE=/^(?:library:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:@[a-f0-9]{64})?|codex:[a-z0-9][a-z0-9._-]{0,79}:[a-f0-9]{12})$/i;

/** Returns only explicit `/skill` commands from human composer text. App skills may pin an immutable revision. */
export function parseExplicitSkillCommands(message:string):string[]{
  const ids:string[]=[];
  for(const line of message.split(/\r?\n/)){
    const trimmed=line.trim();
    if(!/^\/skill(?:\s|$)/i.test(trimmed))continue;
    const match=trimmed.match(/^\/skill\s+(\S+)$/i);
    if(!match)throw new Error('Use `/skill` followed by a saved skill from the suggestions.');
    const ref=match[1].match(SKILL_REFERENCE)?.[0];
    if(!ref)throw new Error('Choose an application or installed Codex skill from the `/skill` suggestions so its reference is unambiguous.');
    if(!ids.includes(ref))ids.push(ref);
  }
  if(ids.length>12)throw new Error('Use up to 12 saved skills in one pass.');
  return ids;
}
