'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const DEFAULT_STATE_DIR = path.join(os.homedir(), '.bridge-runner', 'codex-host');
function readState(dir = DEFAULT_STATE_DIR) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(dir, 'host.json'), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT')
      throw new Error(
        'Codex host has no connection file. Start it with node bin/codex-host.js start, using the same state directory.',
      );
    throw err;
  }
  const state = JSON.parse(raw);
  const url = new URL(state.url);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.pathname !== '/v1/responses' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Invalid local host address');
  if (typeof state.callerToken !== 'string' || state.callerToken.length < 32)
    throw new Error('Invalid local caller token');
  return state;
}
function clientEnvironment(dir) {
  const state = readState(dir);
  // The runner receives only local-service credentials, never an upstream token.
  return { CODEX_BRIDGE_URL: state.url, CODEX_BRIDGE_CALLER_TOKEN: state.callerToken };
}
async function control(dir, operation) {
  const state = readState(dir);
  const res = await fetch(new URL(operation, state.url), {
    method: operation === '/shutdown' ? 'POST' : 'GET',
    headers: { authorization: 'Bearer ' + state.callerToken },
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error('Host control failed: HTTP ' + res.status);
  return res.json();
}
module.exports = { DEFAULT_STATE_DIR, readState, clientEnvironment, control };
