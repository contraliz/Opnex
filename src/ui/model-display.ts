import type { DeepSeekExecutionProfile, ExecutionProfile } from '../types';

export function executionDescriptor(
  profile?: ExecutionProfile,
  deepSeek?: DeepSeekExecutionProfile
) {
  if (!profile) return 'Model details unavailable';
  const model = executionModelName(profile.model);
  return profile.provider === 'deepseek'
    ? `DeepSeek Harness (${deepSeek?.provider === 'opencode-go' ? 'OpenCode Go' : deepSeek?.provider || 'provider'}) · ${model} · requested native effort ${profile.effort} · effective effort unknown`
    : `${model} · ${profile.effort}`;
}

export function executionModelName(model: string) {
  return model === 'gpt-6-luna'
    ? 'GPT-6 Luna'
    : model === 'gpt-6.1-sol'
      ? 'GPT-6.1 Sol'
      : model === 'gpt-6.1-terra'
        ? 'GPT-6.1 Terra'
        : model === 'gpt-6-sol'
          ? 'GPT-6 Sol'
          : model === 'gpt-6-astra'
            ? 'GPT-6 Astra'
            : model === 'deepseek-v4.1-flash'
              ? 'DeepSeek V4.1 Flash'
              : model;
}

export function deepSeekProviderName(deepSeek?: DeepSeekExecutionProfile) {
  return deepSeek?.provider === 'opencode-go'
    ? 'OpenCode Go'
    : deepSeek?.provider || 'provider unknown';
}

export function compactModelName(model: string) {
  return model === 'gpt-6-luna' ? 'Luna' : executionModelName(model);
}

export function executionRoleName(role: 'worker' | 'direct' | 'simple', model?: string) {
  if (role === 'worker') return model ? `${compactModelName(model)} worker` : 'Worker';
  if (role === 'direct') return 'Direct answer';
  return model ? `${executionModelName(model)} simple implementation` : 'Simple implementation';
}
