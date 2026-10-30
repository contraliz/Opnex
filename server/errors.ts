export function errorMessage(error: unknown) {
  const issues = error && typeof error === 'object' && 'issues' in error ? (error as { issues?: unknown }).issues : undefined;
  if (Array.isArray(issues)) {
    const rows = issues.flatMap((issue: any) => {
      if (!issue || typeof issue.message !== 'string') return [];
      const field = Array.isArray(issue.path) ? issue.path.filter((part: unknown) => typeof part === 'string').join(' ').replace(/[A-Z]/g, (letter: string) => ` ${letter.toLowerCase()}`).trim().toLocaleLowerCase() : '';
      return [`${field ? `${field}: ` : ''}${issue.message}`];
    });
    if (rows.length) return `Please check ${rows.join('; ')}.`;
  }
  return error instanceof Error ? error.message : 'Check the supplied information and local service, then try again.';
}

export function safeError(error: unknown) {
  return errorMessage(error).replace(/(?:[A-Z]:\\[^\s]+|\/[^\s]+\.toml)/gi, '[local path]').slice(0, 500);
}
