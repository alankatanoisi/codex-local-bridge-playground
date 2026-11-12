#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { parseArgs } = require('util');
const { createHost } = require('../src/hosting/server');
const { DEFAULT_STATE_DIR, control } = require('../src/hosting/state');
const { resolveAccessToken } = require('../src/runner/codex-transport');
const { scrubSecrets } = require('../src/runner/safety');

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'state-dir': { type: 'string' },
      port: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(
      'codex-host start|serve|status|stop [--port 11448] [--state-dir /absolute/path]\nstart runs in the background; serve stays in this Terminal. Upstream credential: CODEX_ACCESS_TOKEN.',
    );
    return;
  }
  const command = positionals[0] || 'status';
  if (positionals.length > 1 || !['start', 'serve', 'status', 'stop'].includes(command))
    throw new Error('Use start, serve, status, or stop');
  const dir = values['state-dir'] || DEFAULT_STATE_DIR;
  if (!path.isAbsolute(dir)) throw new Error('--state-dir must be absolute');
  if (command === 'status' || command === 'stop') {
    console.log(JSON.stringify(await control(dir, command === 'stop' ? '/shutdown' : '/health')));
    return;
  }
  const port = Number(values.port || 11448);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  if (command === 'start') {
    try {
      const status = await control(dir, '/health');
      console.log(JSON.stringify({ ...status, alreadyRunning: true }));
      return;
    } catch {
      /* No responding managed host. */
    }
    resolveAccessToken();
    const logPath = path.join(dir, 'host.log');
    const previousLogBytes = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
    const log = fs.openSync(logPath, 'a', 0o600);
    const child = spawn(process.execPath, [__filename, 'serve', '--port', String(port), '--state-dir', dir], {
      detached: true,
      stdio: ['ignore', log, log],
      env: process.env,
    });
    fs.closeSync(log);
    child.unref();
    let childExited = false;
    child.once('exit', () => {
      childExited = true;
    });
    let spawnError;
    child.once('error', (err) => {
      spawnError = err;
    });
    for (let n = 0; n < 50; n++) {
      if (spawnError) throw spawnError;
      if (childExited) {
        // Show only this attempt's diagnostics, not old failures from the log.
        const detail = scrubSecrets(
          fs
            .readFileSync(logPath)
            .subarray(previousLogBytes, previousLogBytes + 8192)
            .toString('utf8')
            .trim(),
        );
        throw new Error(detail || 'Codex host exited before it became ready.');
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      try {
        const status = await control(dir, '/health');
        console.log(JSON.stringify(status));
        return;
      } catch {
        /* Wait for listener and state file. */
      }
    }
    child.kill('SIGTERM');
    throw new Error('Host did not become ready. Inspect the private host.log in the state directory.');
  }
  resolveAccessToken();
  // A lock prevents two processes from overwriting each other's credentials.
  // A crash leaves the lock for explicit inspection instead of killing a PID
  // that might have been reused by an unrelated process.
  const lock = path.join(dir, 'host.lock');
  const fd = fs.openSync(lock, 'wx', 0o600);
  fs.writeSync(fd, String(process.pid));
  fs.closeSync(fd);
  let server;
  const cleanup = () => {
    for (const name of ['host.json', 'host.lock']) {
      try {
        fs.unlinkSync(path.join(dir, name));
      } catch {
        /* Already removed. */
      }
    }
  };
  process.once('exit', cleanup);
  try {
    const callerToken = 'sk-local-' + crypto.randomBytes(32).toString('hex');
    server = createHost({ callerToken, onShutdown: cleanup });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    fs.writeFileSync(
      path.join(dir, 'host.json'),
      JSON.stringify({ url: 'http://127.0.0.1:' + port + '/v1/responses', callerToken }),
      { mode: 0o600 },
    );
    console.log(JSON.stringify({ status: 'ready', port }));
    // The authenticated shutdown route cancels active work before closing.
    const shutdown = () =>
      control(dir, '/shutdown').catch(() => {
        server.close();
        server.closeAllConnections();
      });
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  } catch (err) {
    cleanup();
    server?.close();
    if (err.code === 'EADDRINUSE')
      throw new Error(
        'Port ' + port + ' is already in use. Leave that process running and start Codex with --port <unused-port>.',
      );
    throw err;
  }
}
main().catch((err) => {
  console.error(scrubSecrets(err.message));
  process.exitCode = 1;
});
