import { existsSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ForgeSkillSnapshot } from './forge-contracts.js';
import { getSkill, listSkills, skillDatabasePath } from './skill-library.js';
import { loadConfiguredSkill, searchConfiguredSkills } from './worker-staging.js';

export class ForgeKnowledgeSkillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForgeKnowledgeSkillError';
  }
}

/** Resolves one immutable copy of the external knowledge skill; never performs a knowledge-service call. */
export async function loadForgeKnowledgeSkill(
  options: { codexHome?: string; appRoot?: string } = {}
): Promise<ForgeSkillSnapshot> {
  let appRoot = options.appRoot;
  if (!appRoot) {
    try {
      appRoot = await findApplicationRoot();
    } catch {
      /* A configured user skill or the Opnex library may still be available. */
    }
  }
  let configuredError: unknown;
  let matches: Awaited<ReturnType<typeof searchConfiguredSkills>> = [];
  try {
    matches = await searchConfiguredSkills('agentmem-project', options.codexHome, appRoot);
  } catch (error) {
    configuredError = error;
  }
  const selected =
    matches.find(
      (skill) => skill.name.toLowerCase() === 'agentmem-project' && skill.source === 'Project skill'
    ) || matches.find((skill) => skill.name.toLowerCase() === 'agentmem-project');
  if (selected) {
    try {
      const loaded = await loadConfiguredSkill(selected.id, options.codexHome, appRoot);
      return {
        id: loaded.id,
        revision: loaded.revision,
        name: loaded.name,
        description: loaded.description,
        source: loaded.source,
        instructions: loaded.instructions,
        files: loaded.files,
      };
    } catch (error) {
      throw new ForgeKnowledgeSkillError(
        `The selected AgentMem skill could not be snapshotted: ${error instanceof Error ? error.message : 'unknown skill error'}. Restore the exact selected revision before retrying Forge.`
      );
    }
  }
  const fromLibrary = await findLibraryKnowledgeSkill();
  if (fromLibrary) return fromLibrary;
  if (configuredError)
    throw new ForgeKnowledgeSkillError(
      `Forge could not inspect the configured AgentMem skill location: ${configuredError instanceof Error ? configuredError.message : 'unknown filesystem error'}. Install the skill in a configured Codex location or import it into the Opnex Skills library, then retry Forge.`
    );
  throw new ForgeKnowledgeSkillError(
    'The required external AgentMem skill "agentmem-project" is unavailable. Install it in a configured Codex skill location or import it into the Opnex Skills library, then retry Forge.'
  );
}

/** Fallback: the saved Opnex skill library, so an imported skill does not need a Codex installation. */
async function findLibraryKnowledgeSkill(): Promise<ForgeSkillSnapshot | undefined> {
  try {
    if (!existsSync(skillDatabasePath())) return undefined;
    const rows = await listSkills('', false, 500);
    const match = rows.find((row) => row.name.trim().toLowerCase() === 'agentmem-project');
    if (!match) return undefined;
    const skill = await getSkill(match.id);
    return {
      id: skill.id,
      revision: skill.revision,
      name: skill.name,
      description: skill.description,
      source: skill.source,
      instructions: skill.instructions,
      files: skill.files.map((file) => ({ path: file.path, size: file.size })),
    };
  } catch {
    return undefined;
  }
}

async function findApplicationRoot() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.resolve(here, '..'), path.resolve(here, '..', '..')];
  for (const candidate of candidates) {
    const skillPath = path.join(candidate, '.agents', 'skills', 'agentmem-project', 'SKILL.md');
    try {
      const resolvedRoot = await realpath(candidate);
      const resolvedSkill = await realpath(skillPath);
      const relative = path.relative(resolvedRoot, resolvedSkill);
      if (
        relative !== '..' &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative) &&
        (await stat(resolvedSkill)).isFile()
      )
        return resolvedRoot;
    } catch {
      /* Try the other source/build root. */
    }
  }
  throw new ForgeKnowledgeSkillError(
    'The application AgentMem skill source is missing. Restore agentmem-project or install it in the configured Codex skill directory.'
  );
}
