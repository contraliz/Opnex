import type { ChildProcess } from 'node:child_process';

export function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean>;
export function forceStopChildTree(child: ChildProcess): Promise<boolean>;
export function stopChildTree(child: ChildProcess): Promise<boolean>;
