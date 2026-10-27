import readline from 'node:readline';
import path from 'node:path';

const mode = process.argv.find(argument => argument.startsWith('--fixture='))?.split('=')[1] ?? 'normal';
let cwd = process.cwd();
const write = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => write({ jsonrpc: '2.0', id, result });
const error = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });

readline.createInterface({ input: process.stdin }).on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { process.exit(2); }
  const { id, method, params = {} } = message;
  if (method === 'initialize') {
    if (mode === 'auth-error') {
      error(id, -32001, 'Authentication failed for a secret credential value.');
      return;
    }
    reply(id, { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: 'fixture-0.0.1' } });
    return;
  }
  if (method === 'session/prompt') {
    if (mode === 'approval') {
      write({ jsonrpc: '2.0', method: 'session.event', params: { sessionId: params.sessionId, event: { type: 'approval/request' } } });
      return;
    }
    write({ jsonrpc: '2.0', method: 'session.status', params: { sessionId: params.sessionId, status: 'running' } });
    write({ jsonrpc: '2.0', method: 'session.event', params: { sessionId: params.sessionId, event: { type: 'assistant/message', text: 'fixture response' } } });
    reply(id, { accepted: true, sessionId: params.sessionId });
    return;
  }
  if (method === 'session/resume') { reply(id, { sessionId: params.sessionId, resumed: true }); return; }
  if (method === 'session/wait') { reply(id, { sessionId: params.sessionId, status: 'idle' }); return; }
  if (method === 'session/working-directory/get') { reply(id, { cwd: mode === 'escape-cwd' ? path.dirname(cwd) : cwd }); return; }
  if (method === 'session/working-directory/set') { cwd = params.cwd; reply(id, { cwd }); return; }
  if (method === 'shutdown') {
    reply(id, { shutdown: true });
    setImmediate(() => process.exit(0));
    return;
  }
  error(id, -32601, 'Method not found.');
});
