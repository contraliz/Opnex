import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadForgeKnowledgeSkill, ForgeKnowledgeSkillError } from '../server/forge-knowledge-skill.js';

const roots: string[] = [];
async function tempRoot(prefix: string) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  roots.push(root);
  return root;
}
afterEach(async () => {
  const boundary = await realpath(os.tmpdir());
  for (const root of roots.splice(0)) {
    const resolved = await realpath(root);
    const relative = path.relative(boundary, resolved);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Temporary skill fixture escaped its approved test directory.');
    await rm(resolved, { recursive: true, force: true });
  }
});

describe('Forge external knowledge skill snapshot', () => {
  it('loads the exact app skill revision and reports it as a snapshot', async () => {
    const codexHome = await tempRoot('forge-codex-home-');
    const appRoot = await tempRoot('forge-app-root-');
    const skillDirectory = path.join(appRoot, '.agents', 'skills', 'agentmem-project');
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(path.join(skillDirectory, 'SKILL.md'), '---\nname: agentmem-project\ndescription: Use bounded project knowledge.\n---\nVerify the exact canonical root.\n');

    const skill = await loadForgeKnowledgeSkill({ codexHome, appRoot });

    expect(skill).toMatchObject({ name: 'agentmem-project', source: path.join(skillDirectory, 'SKILL.md'), instructions: 'Verify the exact canonical root.' });
    expect(skill.id).toMatch(/^codex:agentmem-project:[a-f0-9]{12}$/);
    expect(skill.revision).toMatch(/^[a-f0-9]{64}$/);
  });

  it('falls back to an imported Opnex library skill when no Codex copy exists', async () => {
    const previous = process.env.PSEUDOHARNESS_DATA_DIR;
    const dataDir = await tempRoot('forge-library-data-');
    process.env.PSEUDOHARNESS_DATA_DIR = dataDir;
    try {
      const library = await import('../server/skill-library.js');
      const created = await library.createSkill({ name: 'agentmem-project', description: 'Library copy.', instructions: 'Use bounded project knowledge.' });
      const codexHome = await tempRoot('forge-codex-home-');
      const appRoot = await tempRoot('forge-app-root-');
      const skill = await loadForgeKnowledgeSkill({ codexHome, appRoot });
      expect(skill).toMatchObject({ id: created.id, name: 'agentmem-project', instructions: 'Use bounded project knowledge.' });
      library.closeSkillLibrary();
    } finally {
      if (previous === undefined) delete process.env.PSEUDOHARNESS_DATA_DIR; else process.env.PSEUDOHARNESS_DATA_DIR = previous;
    }
  });

  it('fails with an actionable missing-skill error instead of creating a synthetic snapshot', async () => {
    const previous = process.env.PSEUDOHARNESS_DATA_DIR;
    const dataDir = await tempRoot('forge-library-empty-');
    process.env.PSEUDOHARNESS_DATA_DIR = dataDir;
    try {
      const codexHome = await tempRoot('forge-codex-home-');
      const appRoot = await tempRoot('forge-app-root-');
      const error = await loadForgeKnowledgeSkill({ codexHome, appRoot }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ForgeKnowledgeSkillError);
      expect((error as Error).message).toMatch(/import it into the Opnex Skills library/i);
    } finally {
      if (previous === undefined) delete process.env.PSEUDOHARNESS_DATA_DIR; else process.env.PSEUDOHARNESS_DATA_DIR = previous;
    }
  });
});
