export type ReadOnlyWorkerResult = {
  name: string;
  status: string;
  receipt?: { result?: string };
  error?: string;
};

function workerResult(worker: ReadOnlyWorkerResult) {
  return (
    worker.receipt?.result?.trim() || worker.error?.trim() || 'No worker response was recorded.'
  );
}

function statusLabel(status: string) {
  return status === 'complete' ? 'completed' : status.replaceAll('_', ' ');
}

export function formatReadOnlyWorkerResults(workers: ReadOnlyWorkerResult[]) {
  if (workers.length === 1) {
    const worker = workers[0]!;
    const result = workerResult(worker);
    return worker.status === 'complete'
      ? result
      : `Worker “${worker.name}” — ${statusLabel(worker.status)}.\n\n${result}`;
  }

  return workers
    .map(
      (worker) => `### ${worker.name} — ${statusLabel(worker.status)}\n\n${workerResult(worker)}`
    )
    .join('\n\n');
}
