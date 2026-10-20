export function isAgentMemEnabled(projectId: string | null | undefined): projectId is string {
  return typeof projectId === 'string' && projectId.trim().length > 0;
}

export async function scopedAgentMemContext<T>(projectId: string | null | undefined, load: (id: string) => Promise<T>) {
  if (!isAgentMemEnabled(projectId)) return { disabled: true as const };
  return load(projectId.trim());
}
