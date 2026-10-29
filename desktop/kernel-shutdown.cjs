const protocolVersion = 1;

async function responseJson(response) {
  try { return await response.json(); } catch { return {}; }
}

function apiError(payload, status) {
  const error = new Error(typeof payload?.error === 'string' ? payload.error : `The local kernel rejected shutdown (${status}).`);
  if (typeof payload?.code === 'string') error.code = payload.code;
  return error;
}

async function stopOwnedKernel({ ownsKernel, origin, fetchImpl = fetch, state, isBackendExited, waitForBackendExit, timeoutMs = 15_000 }) {
  if (ownsKernel !== true) return;
  if (isBackendExited()) return;
  if (!state.shutdownAccepted) {
    let snapshot;
    try {
      snapshot = await fetchImpl(`${origin}/api/v1/snapshot`, {
        headers: { 'x-pseudoharness-protocol-version': String(protocolVersion) },
        signal: AbortSignal.timeout(1_500),
      });
    } catch (error) {
      if (isBackendExited()) return;
      throw new Error(`The managed Opnex kernel could not be reached: ${error instanceof Error ? error.message : String(error)}`);
    }

    const snapshotBody = await responseJson(snapshot);
    if (snapshot.status === 503 && snapshotBody.code === 'KERNEL_SHUTTING_DOWN') {
      state.shutdownAccepted = true;
    } else {
      if (!snapshot.ok) throw apiError(snapshotBody, snapshot.status);
      if (typeof snapshotBody.csrf !== 'string' || !snapshotBody.csrf) throw new Error('The managed kernel did not provide a shutdown token.');

      let stopped;
      try {
        stopped = await fetchImpl(`${origin}/api/v1/kernel/shutdown`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-pseudoharness-protocol-version': String(protocolVersion),
            'x-pseudoharness-token': snapshotBody.csrf,
          },
          body: JSON.stringify({ confirm: 'stop-kernel' }),
          signal: AbortSignal.timeout(5_000),
        });
      } catch (error) {
        if (isBackendExited()) return;
        throw new Error(`The managed kernel shutdown request could not be confirmed: ${error instanceof Error ? error.message : String(error)}`);
      }

      if (stopped.status === 202) state.shutdownAccepted = true;
      else {
        const stoppedBody = await responseJson(stopped);
        if (stopped.status === 409 && stoppedBody.code === 'KERNEL_SHUTTING_DOWN') state.shutdownAccepted = true;
        else throw apiError(stoppedBody, stopped.status);
      }
    }
  }

  if (isBackendExited()) return;
  if (!await waitForBackendExit(timeoutMs)) {
    const error = new Error('The kernel accepted shutdown but has not exited yet. Keep Opnex open and try Quit again after it finishes stopping.');
    error.code = 'KERNEL_EXIT_TIMEOUT';
    throw error;
  }
}

module.exports = { stopOwnedKernel };
